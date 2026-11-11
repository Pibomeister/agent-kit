/**
 * Reference oracle for GAP-05 (FR-05 / AT-06 / AT-07).
 *
 * Status: partial. Deterministic reference only, product behavior unverified.
 * This module is not wired into simplify, docrules, or any product path.
 *
 * Duplicate helpers in the fixture repos are defects. A duplicated
 * security-boundary pair is retained, not offered as cleanup. Findings cite
 * file and line. They do not use a count as the verdict.
 *
 * Security-boundary detection is a fixture-pinning keyword heuristic, not a
 * policy. A pair is tagged `security-boundary` when a name matches
 * require/assert/deny/check/enforce plus auth/session/permission/role/token,
 * or a body matches 401, 403, unauthenticated, unauthorized or forbidden.
 *
 * Supported function forms are `function name(...) { ... }` and
 * `export function name(...) { ... }`, including a default-parameter object
 * such as `function f(a = {}) { ... }`. Arrow functions, methods,
 * `async function`, generators and `const x = function` are not extracted.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const FUNCTION = /(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const SECURITY_NAME = /^(require|assert|deny|check|enforce).*(auth|session|permission|role|token)/i;
const SECURITY_BODY = /\b(401|403|unauthenticated|unauthorized|forbidden)\b/i;

export type DuplicateKind = "helper" | "security-boundary";

export type SymbolSpan = {
  readonly file: string;
  readonly line: number;
  readonly name: string;
};

export type DuplicateHit = {
  readonly kind: DuplicateKind;
  readonly left: SymbolSpan;
  readonly right: SymbolSpan;
};

export type ExtractedFunction = {
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly body: string;
};

function posix(path: string): string {
  return path.split("\\").join("/");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Index just after the matching `)` of the parameter list starting at `from`. */
function afterParams(source: string, from: number): number | null {
  const open = source.indexOf("(", from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function braceBody(source: string, from: number): string | null {
  const paramsEnd = afterParams(source, from);
  if (paramsEnd === null) return null;
  const open = source.indexOf("{", paramsEnd);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

export function extractFunctions(file: string, source: string): readonly ExtractedFunction[] {
  const out: ExtractedFunction[] = [];
  FUNCTION.lastIndex = 0;
  let match = FUNCTION.exec(source);
  while (match !== null) {
    const name = match[1] ?? "";
    const body = braceBody(source, match.index);
    if (name.length > 0 && body !== null) {
      out.push({ file, name, line: lineOf(source, match.index), body: collapse(body) });
    }
    match = FUNCTION.exec(source);
  }
  return out;
}

function listJs(root: string): readonly string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js")) files.push(posix(relative(root, path)));
    }
  };
  walk(root);
  return files.toSorted();
}

function isSecurity(fn: ExtractedFunction): boolean {
  return SECURITY_NAME.test(fn.name) || SECURITY_BODY.test(fn.body);
}

function kindFor(a: ExtractedFunction, b: ExtractedFunction): DuplicateKind {
  return isSecurity(a) || isSecurity(b) ? "security-boundary" : "helper";
}

function ordered(a: ExtractedFunction, b: ExtractedFunction): [ExtractedFunction, ExtractedFunction] {
  if (a.file < b.file) return [a, b];
  if (a.file > b.file) return [b, a];
  return a.line <= b.line ? [a, b] : [b, a];
}

function span(fn: ExtractedFunction): SymbolSpan {
  return { file: fn.file, line: fn.line, name: fn.name };
}

/** Every cross-file pair whose normalized bodies match. */
export function findDuplicateFunctions(root: string): readonly DuplicateHit[] {
  const functions: ExtractedFunction[] = [];
  for (const file of listJs(root)) {
    functions.push(...extractFunctions(file, readFileSync(join(root, file), "utf8")));
  }
  const hits: DuplicateHit[] = [];
  for (let i = 0; i < functions.length; i++) {
    const left = functions[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < functions.length; j++) {
      const right = functions[j];
      if (right === undefined) continue;
      if (left.file === right.file) continue;
      if (left.body !== right.body) continue;
      const [a, b] = ordered(left, right);
      hits.push({ kind: kindFor(a, b), left: span(a), right: span(b) });
    }
  }
  return hits;
}

/** Helpers the fixture oracle would clean. Security-boundary pairs are omitted, not counted. */
export function simplifyDuplicates(root: string): readonly DuplicateHit[] {
  return findDuplicateFunctions(root).filter((hit) => hit.kind === "helper");
}
