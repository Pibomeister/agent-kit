/**
 * A Grok `PreToolUse` hook for the eval subject's private home only. Not a test file.
 *
 * Grok's permission grammar honours an allow rule for a variable argument only as an `ls` or `rg`
 * file operand (`22-permissions-and-safety.md`, Rule Matching Reference), so under `dontAsk` a
 * discovery chain such as `SESSION="/x"; find "$SESSION" -type d` is cancelled although every
 * program in it has a rule. This hook rewrites such a chain into the literal commands it stands
 * for, and the host's own rules then decide the rewritten call.
 *
 * The mechanism is the documented one in the Grok 1.0.46 user guide: every handler receives the
 * model's original tool input and a failed handler never blocks the call (`10-hooks.md:189-191`);
 * `updatedInput` replaces the input before the permission checks see it and must keep the tool's
 * schema (`10-hooks.md:285-310`); hooks run before the permission rules, and `dontAsk` denies
 * whatever is left to prompt for (`22-permissions-and-safety.md:123-136`).
 *
 * A chain is rewritten only when it assigns at least one variable and every segment, after zero
 * or more leading plain `NAME=value` words, is either nothing (a bare assignment, dropped) or a
 * command `grokReadOnlyPermissionRules` admits. Only variables the chain itself assigned are
 * substituted. Anything else prints nothing, so the original call reaches `dontAsk` and the deny
 * rules unchanged: a redirect, a command or process substitution, a backtick, a parenthesis, a
 * backslash, a background `&`, an unclosed quote, an unassigned variable, an unquoted glob, brace
 * or tilde, and a command with no rule. An error in the hook also prints nothing.
 */
import { readFileSync } from "node:fs";
import { grokReadOnlyPermissionRules } from "./shell.ts";

interface Part {
  text: string;
  quote: "'" | '"' | undefined;
}
type Word = Part[];

const UNSAFE_SYNTAX = /[`<>()\\]/;
const ASSIGNMENT = /^([A-Za-z_]\w*)=/;
const VARIABLE = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;
/** Characters an unquoted word hands to the shell: globs, braces, tilde, comment, history. */
const SHELL_ACTIVE = /[*?[\]{}~#!]/;
const PROGRAM = /^[A-Za-z0-9_./+-]+$/;

/** Split a chain into segments of words, each word keeping how its parts were quoted. */
function parseChain(command: string): { segments: Word[][]; operators: string[] } | undefined {
  if (UNSAFE_SYNTAX.test(command)) return undefined;
  let segment: Word[] = [];
  const segments = [segment];
  const operators: string[] = [];
  let word: Word | undefined;
  const endWord = () => {
    if (word !== undefined) segment.push(word);
    word = undefined;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      if (end < 0) return undefined;
      word ??= [];
      word.push({ text: command.slice(i + 1, end), quote: ch });
      i = end;
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      const doubled = ch !== ";" && ch !== "\n" && command[i + 1] === ch;
      const operator = ch === "\n" ? ";" : doubled ? ch + ch : ch;
      endWord();
      if (operator === "&" || segment.length === 0) return undefined;
      operators.push(operator);
      segment = [];
      segments.push(segment);
      if (doubled) i++;
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word ??= [];
      const last = word.at(-1);
      if (last !== undefined && last.quote === undefined) last.text += ch;
      else word.push({ text: ch, quote: undefined });
    }
  }
  endWord();
  return segment.length === 0 ? undefined : { segments, operators };
}

/** The literal text a word stands for, or undefined when the shell would do more than substitute an assigned variable. */
function expand(word: Word, values: ReadonlyMap<string, string>): string | undefined {
  let out = "";
  for (const part of word) {
    if (part.quote === "'") {
      out += part.text;
      continue;
    }
    const bare = part.quote === undefined;
    const literal = part.text.replace(VARIABLE, "");
    if (literal.includes("$") || (bare && SHELL_ACTIVE.test(literal))) return undefined;
    let resolved = true;
    out += part.text.replace(VARIABLE, (whole: string, braced: string | undefined, name: string | undefined) => {
      const value = values.get(braced ?? name ?? "");
      if (value === undefined || (bare && (value === "" || /\s/.test(value) || SHELL_ACTIVE.test(value))))
        resolved = false;
      return value ?? whole;
    });
    if (!resolved) return undefined;
  }
  return out;
}

/** `NAME=value` as a word: the name and the word that is its value. */
function assignmentOf(word: Word): { name: string; value: Word } | undefined {
  const [first, ...rest] = word;
  if (first === undefined || first.quote !== undefined) return undefined;
  const [prefix, name] = ASSIGNMENT.exec(first.text) ?? [];
  if (prefix === undefined || name === undefined) return undefined;
  return { name, value: [{ text: first.text.slice(prefix.length), quote: undefined }, ...rest] };
}

const globRegex = (glob: string) =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

const bashPatterns = (rules: readonly string[]) =>
  rules.flatMap((rule) => (rule.startsWith("Bash(") && rule.endsWith(")") ? [globRegex(rule.slice(5, -1))] : []));

export const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * The literal read-only chain an assignment-carrying chain stands for, or null when the command
 * is not one this hook rewrites. Rules are matched as the host matches them: against the literal
 * words joined by single spaces, without shell quotes.
 */
export function rewriteAssignmentReadChain(command: string): string | null {
  const chain = parseChain(command);
  if (chain === undefined) return null;
  const rules = grokReadOnlyPermissionRules();
  const allow = bashPatterns(rules.allow);
  const deny = bashPatterns(rules.deny);
  const values = new Map<string, string>();
  let rewritten = "";
  for (const [index, segment] of chain.segments.entries()) {
    const literal: string[] = [];
    for (const word of segment) {
      const assignment = literal.length === 0 ? assignmentOf(word) : undefined;
      const text = expand(assignment?.value ?? word, values);
      if (text === undefined) return null;
      if (assignment === undefined) literal.push(text);
      else values.set(assignment.name, text);
    }
    if (literal.length === 0) continue;
    const [program, ...args] = literal;
    if (program === undefined || !PROGRAM.test(program)) return null;
    const seen = literal.join(" ");
    if (!allow.some((pattern) => pattern.test(seen)) || deny.some((pattern) => pattern.test(seen))) return null;
    const quoted = [program, ...args.map(shellQuote)].join(" ");
    rewritten = rewritten === "" ? quoted : `${rewritten} ${chain.operators[index - 1]} ${quoted}`;
  }
  return values.size === 0 || rewritten === "" ? null : rewritten;
}

/** What the hook prints for one `PreToolUse` event on stdin: the rewrite, or nothing. */
export function mediate(event: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(event);
  } catch {
    return "";
  }
  if (!(payload instanceof Object) || !("toolInput" in payload)) return "";
  if ("toolInputTruncated" in payload && payload.toolInputTruncated === true) return "";
  const { toolInput } = payload;
  if (!(toolInput instanceof Object) || !("command" in toolInput) || toolInput.command !== String(toolInput.command))
    return "";
  const rewritten = rewriteAssignmentReadChain(toolInput.command);
  if (rewritten === null) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: Object.fromEntries([...Object.entries(toolInput), ["command", rewritten]]),
    },
  });
}

if (import.meta.main) process.stdout.write(mediate(readFileSync(0, "utf8")));
