/**
 * The guard's one policy evaluator: a normalized tool call, the policy and
 * the call's context in; allow, or deny with a rule id and a one-line reason,
 * out (docs/decisions/0009-constitution-support.md, Decision 2).
 *
 * It is pure. It reads no file, network or clock and holds no state between
 * calls, so a host decoder and encoder around it are the only parts that touch
 * a host, and a replay of recorded payloads exercises exactly what runs.
 *
 * It judges text, not effects. A shell command is lexed (shell.ts) and each
 * simple command judged by its argv tokens after wrappers are stripped; git's
 * global options are skipped before the subcommand, as
 * adapters/firstmate/hooks/child-guard.sh does, so `git -C . push` reaches
 * the same rules as `git push`. Inline interpreter code is not run: code that
 * names a protected or secret path is denied, and code that does not is
 * allowed. That, and the rest of what it cannot see, is listed in
 * schemas/guard-policy.schema.json as the evaluator's known gaps. Anything it
 * cannot classify at all is denied as `guard.unjudgeable`.
 */
import type { GuardAction, GuardContext } from "./action.ts";
import { compileGlob, coversPrefix, type CompiledGlob } from "./glob.ts";
import type { DestructiveCommand, GuardPolicy, PathTier, ProtectedPath, SecretPath } from "./policy.ts";
import { DYNAMIC, HOME, parseShell, type SimpleCommand, type Stdin, type Word } from "./shell.ts";

export type GuardVerdict = { decision: "allow" } | { decision: "deny"; rule: string; reason: string };

export const UNJUDGEABLE = "guard.unjudgeable";
export const NO_VERIFY = "guard.git-no-verify";

/** Shells inside shells inside substitutions: past this the text is denied rather than followed. */
const MAX_DEPTH = 8;

interface Deny {
  rule: string;
  reason: string;
}

interface Rule<T> {
  entry: T;
  globs: CompiledGlob[];
}

interface Compiled {
  protectedPaths: Rule<ProtectedPath>[];
  secrets: Rule<SecretPath>[];
  never: Rule<PathTier>[];
  askFirst: Rule<PathTier>[];
  destructive: DestructiveCommand[];
  scope: CompiledGlob[];
  root: string;
  home: string | null;
}

/** Where a path lies: workspace-relative when the workspace contains it, otherwise located only by floating globs. */
type View = { anchored: true; rel: string } | { anchored: false; path: string };

/** How a path is touched, which decides how it is matched. */
type Touch = "file" | "tree" | "named";

interface ShellState {
  /** The working directory, or null once a `cd` went somewhere the text does not say. */
  dir: string | null;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function evaluate(policy: GuardPolicy, action: GuardAction, context: GuardContext): GuardVerdict {
  const compiled = compilePolicy(policy, context);
  if (compiled === null) return deny(unjudgeable("the policy or the ticket scope holds a glob that does not compile"));
  const judge = new Judge(compiled);
  const found = judge.action(action, context.cwd ?? context.root);
  return found === null ? { decision: "allow" } : deny(found);
}

function deny(found: Deny): GuardVerdict {
  return { decision: "deny", rule: found.rule, reason: found.reason };
}

function unjudgeable(why: string): Deny {
  return { rule: UNJUDGEABLE, reason: `The guard cannot judge this call: ${why}.` };
}

function compileRules<T extends { globs: string[] }>(entries: ReadonlyArray<T>): Rule<T>[] | null {
  const out: Rule<T>[] = [];
  for (const entry of entries) {
    const globs = compileAll(entry.globs);
    if (globs === null) return null;
    out.push({ entry, globs });
  }
  return out;
}

function compileAll(globs: ReadonlyArray<string>): CompiledGlob[] | null {
  const out: CompiledGlob[] = [];
  for (const glob of globs) {
    const compiled = compileGlob(glob);
    if (compiled === null) return null;
    out.push(compiled);
  }
  return out;
}

function compilePolicy(policy: GuardPolicy, context: GuardContext): Compiled | null {
  const protectedPaths = compileRules(policy.protected_paths);
  const secrets = compileRules(policy.secret_paths);
  const never = compileRules(policy.path_tiers.filter((t) => t.tier === "never"));
  const askFirst = compileRules(policy.path_tiers.filter((t) => t.tier === "ask-first"));
  const scope = compileAll(context.scope?.files ?? []);
  if (protectedPaths === null || secrets === null || never === null || askFirst === null || scope === null) return null;
  return {
    protectedPaths,
    secrets,
    never,
    askFirst,
    destructive: policy.destructive_commands,
    scope,
    root: normalizeAbsolute(context.root),
    home: context.home === undefined ? null : normalizeAbsolute(context.home),
  };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function normalizeSegments(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(segment);
  }
  return out;
}

function normalizeAbsolute(path: string): string {
  return `/${normalizeSegments(path)
    .filter((s) => s !== "..")
    .join("/")}`;
}

function normalizeRelative(path: string): string {
  return normalizeSegments(path).join("/");
}

function show(text: string): string {
  return text.replaceAll(DYNAMIC, "$…").replaceAll(HOME, "~");
}

function base(text: string): string {
  const slash = text.lastIndexOf("/");
  return slash < 0 ? text : text.slice(slash + 1);
}

function hasWildcard(segment: string): boolean {
  return /[*?[]/.test(segment);
}

function matchesFile(glob: CompiledGlob, view: View): boolean {
  return view.anchored ? glob.regex.test(view.rel) : glob.floating && glob.regex.test(view.path);
}

/** The view's segments up to the first that holds a wildcard, which is the most a pattern operand fixes. */
function fixedSegments(view: View): string[] {
  if (!view.anchored || view.rel === "") return [];
  const out: string[] = [];
  for (const segment of view.rel.split("/")) {
    if (hasWildcard(segment)) break;
    out.push(segment);
  }
  return out;
}

function matches(glob: CompiledGlob, view: View, touch: Touch): boolean {
  if (matchesFile(glob, view)) return true;
  if (touch === "file" || !view.anchored) return false;
  const segments = fixedSegments(view);
  // A name in code reaches a directory only when it names one; the bare root is every path.
  if (touch === "named" && segments.length === 0) return false;
  return coversPrefix(glob, segments);
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
const READ_REDIRECTS = new Set(["<", "<>"]);
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until"]);

interface WrapperSpec {
  arg: ReadonlyArray<string>;
  long: ReadonlyArray<string>;
  positional: number;
}

const WRAPPERS = new Map<string, WrapperSpec>([
  ["env", { arg: ["-u", "-C", "-S"], long: ["--unset", "--chdir", "--split-string"], positional: 0 }],
  [
    "sudo",
    {
      arg: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"],
      long: ["--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user"],
      positional: 0,
    },
  ],
  ["doas", { arg: ["-u", "-C"], long: [], positional: 0 }],
  ["nice", { arg: ["-n"], long: ["--adjustment"], positional: 0 }],
  ["nohup", { arg: [], long: [], positional: 0 }],
  ["time", { arg: ["-f", "-o"], long: ["--format", "--output"], positional: 0 }],
  ["command", { arg: [], long: [], positional: 0 }],
  ["builtin", { arg: [], long: [], positional: 0 }],
  ["exec", { arg: ["-a"], long: [], positional: 0 }],
  ["timeout", { arg: ["-s", "-k"], long: ["--signal", "--kill-after"], positional: 1 }],
  ["stdbuf", { arg: ["-i", "-o", "-e"], long: ["--input", "--output", "--error"], positional: 0 }],
  ["ionice", { arg: ["-c", "-n"], long: ["--class", "--classdata"], positional: 0 }],
  ["setsid", { arg: [], long: [], positional: 0 }],
  ["unbuffer", { arg: [], long: [], positional: 0 }],
  [
    "xargs",
    {
      arg: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a"],
      long: [
        "--arg-file",
        "--delimiter",
        "--max-args",
        "--max-procs",
        "--max-chars",
        "--max-lines",
        "--replace",
        "--eof",
      ],
      positional: 0,
    },
  ],
]);

/** Programs whose every operand is a path they change, move, link or remove. */
const ALL_OPERANDS = new Map<string, ReadonlyArray<string>>([
  ["rm", []],
  ["rmdir", []],
  ["unlink", []],
  ["shred", ["-n", "-s"]],
  ["touch", ["-d", "-t", "-r"]],
  ["truncate", ["-s", "-r"]],
  ["mkdir", ["-m"]],
  ["chmod", []],
  ["chown", []],
  ["chgrp", []],
  ["mv", ["-t", "-S"]],
  ["ln", ["-t", "-S"]],
  ["tee", []],
]);

/** Programs whose last operand, or `-t` directory, is the path they write. */
const LAST_OPERAND = new Map<string, ReadonlyArray<string>>([
  ["cp", ["-t", "-S"]],
  ["install", ["-t", "-m", "-o", "-g", "-S"]],
  ["rsync", ["-e", "-f"]],
]);

interface InterpreterSpec {
  /** Short options whose value is inline code. For a shell, `-c` instead makes the first operand the code. */
  codeShort: string;
  codeLong: ReadonlyArray<string>;
  /** Short options that name a script or module to run instead. */
  scriptShort: string;
  scriptLong: ReadonlyArray<string>;
  /** Short options that take the next token as their value. */
  argShort: string;
  argLong: ReadonlyArray<string>;
  /** Short options whose value is the rest of their token. */
  attachedShort: string;
  shell: boolean;
  /** The first operand is the program text, as for awk and sed. */
  firstOperandIsCode: boolean;
  /** `-i` edits the operands in place. */
  inPlace: boolean;
}

const SPEC_DEFAULTS: InterpreterSpec = {
  codeShort: "",
  codeLong: [],
  scriptShort: "",
  scriptLong: [],
  argShort: "",
  argLong: [],
  attachedShort: "",
  shell: false,
  firstOperandIsCode: false,
  inPlace: false,
};

const SHELL_SPEC: InterpreterSpec = { ...SPEC_DEFAULTS, codeShort: "c", argShort: "oO", shell: true };
const PYTHON_SPEC: InterpreterSpec = { ...SPEC_DEFAULTS, codeShort: "c", scriptShort: "m", argShort: "WX" };
const NODE_SPEC: InterpreterSpec = {
  ...SPEC_DEFAULTS,
  codeShort: "ep",
  codeLong: ["--eval", "--print"],
  argShort: "rC",
  argLong: ["--require", "--import", "--loader", "--experimental-loader", "--input-type", "--conditions"],
};
const PERL_SPEC: InterpreterSpec = {
  ...SPEC_DEFAULTS,
  codeShort: "eE",
  attachedShort: "IMmxdDCil0",
  inPlace: true,
};
const RUBY_SPEC: InterpreterSpec = { ...SPEC_DEFAULTS, codeShort: "e", attachedShort: "IrCKEFTx0il", inPlace: true };
const PHP_SPEC: InterpreterSpec = { ...SPEC_DEFAULTS, codeShort: "r", scriptShort: "f", argShort: "cdz" };
const AWK_SPEC: InterpreterSpec = {
  ...SPEC_DEFAULTS,
  codeShort: "e",
  codeLong: ["--source"],
  scriptShort: "f",
  scriptLong: ["--file"],
  argShort: "Fv",
  argLong: ["--field-separator", "--assign"],
  firstOperandIsCode: true,
};
const SED_SPEC: InterpreterSpec = {
  ...SPEC_DEFAULTS,
  codeShort: "e",
  codeLong: ["--expression"],
  scriptShort: "f",
  scriptLong: ["--file"],
  argShort: "l",
  firstOperandIsCode: true,
};

function interpreterFor(program: string): InterpreterSpec | null {
  if (/^(sh|bash|zsh|dash|ksh|ash|mksh)$/.test(program)) return SHELL_SPEC;
  if (/^(python[0-9.]*|pypy[0-9.]*)$/.test(program)) return PYTHON_SPEC;
  if (/^(node|nodejs|bun)$/.test(program)) return NODE_SPEC;
  if (program === "perl") return PERL_SPEC;
  if (program === "ruby") return RUBY_SPEC;
  if (program === "php") return PHP_SPEC;
  if (/^[gmn]?awk$/.test(program)) return AWK_SPEC;
  if (program === "sed") return SED_SPEC;
  return null;
}

interface InterpreterCall {
  mode: "code" | "script" | "stdin" | "missing";
  codes: Word[];
  operands: Word[];
  inPlace: boolean;
}

function readInterpreter(spec: InterpreterSpec, args: ReadonlyArray<Word>): InterpreterCall {
  const codes: Word[] = [];
  const operands: Word[] = [];
  let script = false;
  let shellCode = false;
  let stdinFlag = false;
  let inPlace = false;
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    const t = word.text;
    if (!optionsEnded && t === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && t === "-") {
      stdinFlag = true;
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq < 0 ? t : t.slice(0, eq);
      if (spec.codeLong.includes(name)) {
        const code = eq < 0 ? args[++i] : { ...word, text: t.slice(eq + 1) };
        if (code === undefined) return { mode: "missing", codes, operands, inPlace };
        codes.push(code);
      } else if (spec.scriptLong.includes(name)) {
        script = true;
        if (eq < 0) i += 1;
      } else if (spec.argLong.includes(name) && eq < 0) i += 1;
      continue;
    }
    if (!optionsEnded && t.length > 1 && (t.startsWith("-") || (spec.shell && t.startsWith("+")))) {
      if (t.startsWith("+")) {
        if (t.includes("o")) i += 1;
        continue;
      }
      for (let j = 1; j < t.length; j++) {
        const c = t.charAt(j);
        const rest = t.slice(j + 1);
        if (spec.codeShort.includes(c)) {
          if (spec.shell) {
            shellCode = true;
            continue;
          }
          const code = onlyFrom(rest, spec.codeShort) ? args[++i] : { ...word, text: rest };
          if (code === undefined) return { mode: "missing", codes, operands, inPlace };
          codes.push(code);
          break;
        }
        if (spec.scriptShort.includes(c)) {
          script = true;
          if (rest === "") i += 1;
          break;
        }
        if (spec.argShort.includes(c)) {
          if (rest === "") i += 1;
          break;
        }
        if (spec.attachedShort.includes(c)) {
          if (c === "i" && spec.inPlace) inPlace = true;
          break;
        }
        if (spec.shell && c === "s") stdinFlag = true;
      }
      continue;
    }
    if (spec.shell && shellCode && codes.length === 0) {
      // `sh -c CODE NAME ARGS`: what follows the code is its $0 and positional parameters.
      codes.push(word);
      break;
    }
    if (spec.firstOperandIsCode && codes.length === 0 && !script) {
      codes.push(word);
      continue;
    }
    if (codes.length === 0 && !script && !spec.firstOperandIsCode) {
      // The first operand is a script, and everything after it is that script's.
      return { mode: "script", codes, operands, inPlace };
    }
    operands.push(word);
  }
  if (spec.shell && shellCode && codes.length === 0) return { mode: "missing", codes, operands, inPlace };
  if (codes.length > 0) return { mode: "code", codes, operands, inPlace };
  if (script) return { mode: "script", codes, operands, inPlace };
  return { mode: stdinFlag || operands.length === 0 ? "stdin" : "script", codes, operands, inPlace };
}

/** Operands after options, given which options take a value. Everything after `--` is an operand. */
function operandsOf(args: ReadonlyArray<Word>, valued: ReadonlyArray<string>): Word[] {
  const out: Word[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    const t = word.text;
    if (optionsEnded || !t.startsWith("-") || t === "-") {
      out.push(word);
    } else if (t === "--") {
      optionsEnded = true;
    } else if (valued.includes(t)) {
      i += 1;
    }
  }
  return out;
}

/** The value of `-x VALUE`, `-xVALUE`, `--long VALUE` or `--long=VALUE` for each listed spelling. */
function optionValues(args: ReadonlyArray<Word>, short: ReadonlyArray<string>, long: ReadonlyArray<string>): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) break;
    const t = word.text;
    if (t === "--") break;
    const next = args[i + 1];
    if (short.includes(t) || long.includes(t)) {
      if (next !== undefined) out.push(next);
      i += 1;
      continue;
    }
    for (const s of short) {
      if (t.startsWith(s) && t.length > s.length && !t.startsWith("--")) out.push({ ...word, text: t.slice(s.length) });
    }
    for (const l of long) {
      if (t.startsWith(`${l}=`)) out.push({ ...word, text: t.slice(l.length + 1) });
    }
  }
  return out;
}

function optionMatches(token: string, option: string): boolean {
  if (token === option) return true;
  if (option.startsWith("--")) return token.startsWith(`${option}=`);
  if (option.length === 2 && /^-[A-Za-z0-9]{2,}$/.test(token)) return token.slice(1).includes(option.charAt(1));
  return false;
}

function optionTokens(args: ReadonlyArray<Word>): string[] {
  const out: string[] = [];
  for (const word of args) {
    if (word.text === "--") break;
    if (word.text.startsWith("-")) out.push(word.text);
  }
  return out;
}

function literal(text: string): Word {
  return { text, dynamic: false, quoted: false };
}

function codeTokens(code: string): string[] {
  return code
    .replaceAll(HOME, "~")
    .split(/[^A-Za-z0-9_./~@+-]+/)
    .filter((t) => t !== "" && t !== "." && t !== "..");
}

function onlyFrom(text: string, allowed: string): boolean {
  for (let i = 0; i < text.length; i++) if (!allowed.includes(text.charAt(i))) return false;
  return true;
}

class Judge {
  private readonly c: Compiled;

  constructor(compiled: Compiled) {
    this.c = compiled;
  }

  action(action: GuardAction, cwd: string): Deny | null {
    const dir = normalizeAbsolute(cwd);
    switch (action.kind) {
      case "shell": {
        if (action.argv.length === 0) return unjudgeable("the shell call has no argv");
        return this.words(action.argv.map(literal), { kind: "terminal" }, { dir }, 0, true);
      }
      case "read": {
        if (action.paths.length === 0) return unjudgeable("the read names no path");
        for (const path of action.paths) {
          const found = this.read(path, dir, `a read of ${path}`);
          if (found !== null) return found;
        }
        return null;
      }
      default: {
        if (action.paths.length === 0) return unjudgeable(`the ${action.kind} names no path it touches`);
        for (const path of action.paths) {
          const found = this.write(path, dir, "file", `a ${action.kind} of ${path}`);
          if (found !== null) return found;
        }
        return null;
      }
    }
  }

  // --- paths ---------------------------------------------------------------

  private locate(raw: string, dir: string | null): View[] | null {
    let text = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    if (text.slice(1).includes(HOME)) text = text.slice(0, 1) + text.slice(1).replaceAll(HOME, DYNAMIC);
    if (text.includes(DYNAMIC)) {
      const suffix = normalizeRelative(text.slice(text.lastIndexOf(DYNAMIC) + 1));
      if (suffix === "") return null;
      return [
        { anchored: true, rel: suffix },
        { anchored: false, path: suffix },
      ];
    }
    if (text.startsWith(HOME)) {
      if (this.c.home === null) return [{ anchored: false, path: normalizeRelative(text.slice(1)) }];
      text = `${this.c.home}/${text.slice(1)}`;
    }
    if (text.startsWith("/")) return [this.fromAbsolute(normalizeAbsolute(text))];
    if (dir !== null) return [this.fromAbsolute(normalizeAbsolute(`${dir}/${text}`))];
    const rel = normalizeRelative(text);
    return [
      { anchored: true, rel },
      { anchored: false, path: rel },
    ];
  }

  private fromAbsolute(abs: string): View {
    const root = this.c.root;
    if (abs === root) return { anchored: true, rel: "" };
    if (root === "/") return { anchored: true, rel: abs.slice(1) };
    if (abs.startsWith(`${root}/`)) return { anchored: true, rel: abs.slice(root.length + 1) };
    return { anchored: false, path: abs.slice(1) };
  }

  private scopeLifts(views: ReadonlyArray<View>): boolean {
    return views.some((v) => v.anchored && this.c.scope.some((g) => g.regex.test(v.rel)));
  }

  private protectedHit(views: ReadonlyArray<View>, touch: Touch): Deny | null {
    for (const rule of this.c.protectedPaths) {
      const hit = views.some((v) => rule.globs.some((g) => matches(g, v, touch)));
      if (!hit) continue;
      if (rule.entry.category === "tests" && this.scopeLifts(views)) continue;
      return { rule: rule.entry.id, reason: rule.entry.reason };
    }
    for (const rule of this.c.never) {
      if (views.some((v) => rule.globs.some((g) => matches(g, v, touch)))) {
        return { rule: rule.entry.id, reason: rule.entry.reason };
      }
    }
    for (const rule of this.c.askFirst) {
      if (views.some((v) => rule.globs.some((g) => matches(g, v, touch)))) {
        return {
          rule: rule.entry.id,
          reason: `${rule.entry.reason}; the path is ask-first and no grant covers this write`,
        };
      }
    }
    return null;
  }

  private secretHit(views: ReadonlyArray<View>): Deny | null {
    for (const rule of this.c.secrets) {
      if (views.some((v) => rule.globs.some((g) => matchesFile(g, v)))) {
        return { rule: rule.entry.id, reason: rule.entry.reason };
      }
    }
    return null;
  }

  private write(raw: string, dir: string | null, touch: Touch, what: string): Deny | null {
    const views = this.locate(raw, dir);
    if (views === null) return unjudgeable(`${show(what)} writes a path known only at run time`);
    const hit = this.protectedHit(views, touch);
    return hit === null ? null : { rule: hit.rule, reason: `${hit.reason} (${show(what)})` };
  }

  private read(raw: string, dir: string | null, what: string): Deny | null {
    const views = this.locate(raw, dir);
    if (views === null) return null;
    const hit = this.secretHit(views);
    return hit === null ? null : { rule: hit.rule, reason: `${hit.reason} (${show(what)})` };
  }

  /** Inline code is not run, so a path it names is taken as one it may read or write. */
  private named(code: string, dir: string | null, program: string): Deny | null {
    for (const raw of codeTokens(code)) {
      const token = raw.startsWith("~/") ? `${HOME}${raw.slice(1)}` : raw;
      const views = this.locate(token, dir) ?? [];
      // `root + "/tests/x"` leaves a leading slash on a workspace path.
      if (token.startsWith("/")) views.push({ anchored: true, rel: normalizeRelative(token) });
      const hit = this.secretHit(views) ?? this.protectedHit(views, "named");
      if (hit !== null)
        return { rule: hit.rule, reason: `${hit.reason} (inline ${program} code names ${show(token)})` };
    }
    return null;
  }

  // --- shell ---------------------------------------------------------------

  private shellText(text: string, state: ShellState, depth: number): Deny | null {
    if (depth > MAX_DEPTH) return unjudgeable(`shell nests more than ${MAX_DEPTH} levels deep`);
    const parsed = parseShell(text);
    if (parsed === null) return unjudgeable("the shell text does not parse (an unterminated quote or substitution)");
    for (const inner of parsed.nested) {
      const found = this.shellText(inner, { dir: state.dir }, depth + 1);
      if (found !== null) return found;
    }
    for (const command of parsed.commands) {
      const found = this.command(command, state, depth);
      if (found !== null) return found;
    }
    return null;
  }

  private command(command: SimpleCommand, state: ShellState, depth: number): Deny | null {
    for (const r of command.redirects) {
      const target = r.target.text;
      if (WRITE_REDIRECTS.has(r.op) && !(r.op === ">&" && /^([0-9]+-?|-)$/.test(target))) {
        const found = this.write(target, state.dir, "file", `a redirection to ${target}`);
        if (found !== null) return found;
      }
      if (READ_REDIRECTS.has(r.op)) {
        const found = this.read(target, state.dir, `a redirection from ${target}`);
        if (found !== null) return found;
      }
    }
    return this.words(command.words, command.stdin, state, depth, false);
  }

  private words(
    all: ReadonlyArray<Word>,
    stdin: Stdin,
    state: ShellState,
    depth: number,
    hostShell: boolean,
  ): Deny | null {
    // The host's own shell text is lexed below, word by word, rather than read as one path.
    const hostCode =
      hostShell && all[0] !== undefined && interpreterFor(base(all[0].text)) === SHELL_SPEC
        ? readInterpreter(SHELL_SPEC, all.slice(1)).codes[0]
        : undefined;
    for (const word of all) {
      if (word === hostCode) continue;
      const eq = word.text.indexOf("=");
      const candidates = eq > 0 ? [word.text, word.text.slice(eq + 1)] : [word.text];
      for (const candidate of candidates) {
        const found = this.read(candidate, state.dir, `an argument naming ${candidate}`);
        if (found !== null) return found;
      }
    }
    let rest = [...all];
    for (;;) {
      while (rest[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0].text)) rest = rest.slice(1);
      const head = rest[0];
      if (head === undefined) return null;
      if (head.dynamic) return unjudgeable(`the program ${show(head.text)} is computed at run time`);
      if (KEYWORDS.has(head.text)) {
        rest = rest.slice(1);
        continue;
      }
      const program = base(head.text);
      const wrapper = WRAPPERS.get(program);
      if (wrapper === undefined) break;
      if (program === "command" && rest[1] !== undefined && /^-[vV]/.test(rest[1].text)) return null;
      if (program === "env") {
        for (const split of optionValues(rest.slice(1), ["-S"], ["--split-string"])) {
          if (split.dynamic) return unjudgeable("env -S splits a string known only at run time");
          const found = this.shellText(split.text, { dir: state.dir }, depth + 1);
          if (found !== null) return found;
        }
      }
      rest = this.unwrap(rest.slice(1), wrapper);
    }
    const head = rest[0];
    if (head === undefined) return null;
    const program = base(head.text);
    const args = rest.slice(1);

    switch (program) {
      case "cd":
      case "pushd":
        this.changeDir(args, state);
        return null;
      case "popd":
        state.dir = null;
        return null;
      case "eval": {
        if (args.some((a) => a.dynamic)) return unjudgeable("eval runs text known only at run time");
        return this.shellText(args.map((a) => a.text).join(" "), { dir: state.dir }, depth + 1);
      }
      case "git":
        return this.git(args, state, depth);
      case "find": {
        const found = this.find(args, state, depth);
        if (found !== null) return found;
        break;
      }
      default:
        break;
    }

    const destructive = this.destructive(program, args, null);
    if (destructive !== null) return destructive;

    const spec = interpreterFor(program);
    if (spec !== null) {
      const found = this.interpreter(program, spec, args, stdin, state, depth, hostShell);
      if (found !== null) return found;
    }
    if (program === "sed") return this.sedInPlace(args, state);
    if (program === "deno" && args[0]?.text === "eval") {
      const code = args[1];
      if (code === undefined) return unjudgeable("deno eval has no code");
      if (code.dynamic && code.text.replaceAll(DYNAMIC, "") === "")
        return unjudgeable("deno eval runs code known only at run time");
      return this.named(code.text, state.dir, program);
    }
    return this.writeCommand(program, args, state);
  }

  private unwrap(args: ReadonlyArray<Word>, spec: WrapperSpec): Word[] {
    let i = 0;
    let positional = spec.positional;
    while (i < args.length) {
      const t = args[i]?.text ?? "";
      if (t === "--") {
        i += 1;
        break;
      }
      if (t.startsWith("--")) {
        i += spec.long.includes(t) ? 2 : 1;
        continue;
      }
      if (t.startsWith("-") && t.length > 1) {
        i += spec.arg.includes(t) ? 2 : 1;
        continue;
      }
      if (positional > 0) {
        positional -= 1;
        i += 1;
        continue;
      }
      break;
    }
    return args.slice(i);
  }

  private changeDir(args: ReadonlyArray<Word>, state: ShellState): void {
    const target = args.find((a) => !a.text.startsWith("-") || a.text === "-");
    if (target === undefined) {
      state.dir = this.c.home;
      return;
    }
    if (target.dynamic || target.text === "-") {
      state.dir = null;
      return;
    }
    let text = target.text;
    if (text.startsWith(HOME)) {
      if (this.c.home === null) {
        state.dir = null;
        return;
      }
      text = `${this.c.home}/${text.slice(1)}`;
    }
    if (text.startsWith("/")) state.dir = normalizeAbsolute(text);
    else state.dir = state.dir === null ? null : normalizeAbsolute(`${state.dir}/${text}`);
  }

  private destructive(program: string, args: ReadonlyArray<Word>, gitSubcommand: number | null): Deny | null {
    for (const pattern of this.c.destructive) {
      if (pattern.program !== program) continue;
      let options: ReadonlyArray<Word> = args;
      if (pattern.subcommand !== undefined) {
        const index = gitSubcommand ?? args.findIndex((a) => !a.text.startsWith("-"));
        if (index < 0 || args[index]?.text !== pattern.subcommand) continue;
        options = args.slice(index + 1);
      } else if (gitSubcommand !== null) {
        options = args.slice(gitSubcommand + 1);
      }
      const tokens = optionTokens(options);
      const groups = pattern.all_of ?? [];
      if (groups.every((group) => group.some((option) => tokens.some((t) => optionMatches(t, option))))) {
        return {
          rule: pattern.id,
          reason: `${pattern.reason} (${[program, ...args.map((a) => show(a.text))].join(" ")})`,
        };
      }
    }
    return null;
  }

  private git(args: ReadonlyArray<Word>, state: ShellState, depth: number): Deny | null {
    const aliases = new Map<string, string>();
    let dir = state.dir;
    let i = 0;
    while (i < args.length) {
      const word = args[i];
      if (word === undefined) break;
      const t = word.text;
      if (t === "-C") {
        const target = args[i + 1];
        dir = target === undefined || target.dynamic ? null : this.resolveDir(target.text, dir);
        i += 2;
      } else if (t === "-c" || t === "--config-env") {
        const setting = args[i + 1]?.text ?? "";
        const eq = setting.indexOf("=");
        const key = (eq < 0 ? setting : setting.slice(0, eq)).toLowerCase();
        if (key === "core.hookspath") {
          return {
            rule: NO_VERIFY,
            reason: `git ${t} ${show(setting)} replaces the repository's hooks; run git without it`,
          };
        }
        if (t === "-c" && key.startsWith("alias.") && eq > 0) aliases.set(key.slice(6), setting.slice(eq + 1));
        i += 2;
      } else if (["--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(t)) {
        i += 2;
      } else if (t.startsWith("-")) {
        i += 1;
      } else break;
    }
    const sub = args[i];
    if (sub === undefined) return null;
    if (sub.dynamic) return unjudgeable(`the git subcommand ${show(sub.text)} is computed at run time`);
    const rest = args.slice(i + 1);

    const alias = aliases.get(sub.text.toLowerCase());
    if (alias !== undefined) {
      if (alias.startsWith("!")) return this.shellText(alias.slice(1), { dir }, depth + 1);
      const expanded = parseShell(alias)?.commands[0]?.words;
      if (expanded === undefined) return unjudgeable(`the git alias ${sub.text} does not parse`);
      return this.git([...args.slice(0, i), ...expanded, ...rest], { dir }, depth + 1);
    }

    for (let j = 0; j < rest.length; j++) {
      const t = rest[j]?.text ?? "";
      if (t === "--") break;
      if (t === "-m" || t === "-F" || t === "--message" || t === "--file") {
        j += 1;
        continue;
      }
      if (t === "--no-verify" || t.startsWith("--no-verify=")) {
        return {
          rule: NO_VERIFY,
          reason: `git ${sub.text} --no-verify skips the repository's hooks; run it without --no-verify`,
        };
      }
      if (sub.text === "commit" && /^-[A-Za-z]*n/.test(t) && !t.startsWith("--")) {
        return {
          rule: NO_VERIFY,
          reason: `git commit ${t} skips the repository's hooks; -n is --no-verify for commit`,
        };
      }
    }

    const destructive = this.destructive("git", args, i);
    if (destructive !== null) return destructive;

    let targets: Word[] = [];
    if (sub.text === "rm" || sub.text === "mv") targets = operandsOf(rest, []);
    else if (sub.text === "restore") targets = operandsOf(rest, ["-s", "--source"]);
    else if (sub.text === "checkout") {
      const dashes = rest.findIndex((w) => w.text === "--");
      targets = dashes < 0 ? [] : rest.slice(dashes + 1);
    }
    for (const target of targets) {
      const found = this.write(target.text, dir, "tree", `git ${sub.text} ${target.text}`);
      if (found !== null) return found;
    }
    return null;
  }

  private resolveDir(text: string, dir: string | null): string | null {
    if (text.startsWith(HOME))
      return this.c.home === null ? null : normalizeAbsolute(`${this.c.home}/${text.slice(1)}`);
    if (text.startsWith("/")) return normalizeAbsolute(text);
    return dir === null ? null : normalizeAbsolute(`${dir}/${text}`);
  }

  private find(args: ReadonlyArray<Word>, state: ShellState, depth: number): Deny | null {
    const first = args.findIndex((a) => a.text.startsWith("-") || a.text === "(" || a.text === "!");
    const roots = first < 0 ? args : args.slice(0, first);
    const expression = first < 0 ? [] : args.slice(first);
    const changes = expression.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a.text));
    if (!changes) return null;
    for (const root of roots.length > 0 ? roots : [literal(".")]) {
      const found = this.write(root.text, state.dir, "tree", `find ${root.text} changing what it finds`);
      if (found !== null) return found;
    }
    for (let i = 0; i < expression.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(expression[i]?.text ?? "")) continue;
      const end = expression.findIndex((a, k) => k > i && (a.text === ";" || a.text === "+"));
      const inner = expression.slice(i + 1, end < 0 ? expression.length : end);
      const found = this.words(inner, { kind: "terminal" }, { dir: state.dir }, depth + 1, false);
      if (found !== null) return found;
    }
    return null;
  }

  private interpreter(
    program: string,
    spec: InterpreterSpec,
    args: ReadonlyArray<Word>,
    stdin: Stdin,
    state: ShellState,
    depth: number,
    hostShell: boolean,
  ): Deny | null {
    const call = readInterpreter(spec, args);
    let codes: Word[] = call.codes;
    if (call.mode === "missing") return unjudgeable(`${program} was given a code option with no code`);
    if (call.mode === "script") return null;
    if (call.mode === "stdin") {
      if (stdin.kind === "pipe" || stdin.kind === "file") {
        return unjudgeable(`${program} runs code it reads from a pipe or a file`);
      }
      if (stdin.kind === "terminal") return null;
      codes = [{ text: stdin.text, dynamic: false, quoted: true }];
    }
    for (const code of codes) {
      if (code.dynamic && code.text.replaceAll(DYNAMIC, "").trim() === "") {
        return unjudgeable(`${program} runs code known only at run time`);
      }
      if (spec.shell) {
        // The host's own shell is lexed in full; a shell the command starts is also held to the naming rule.
        const found = this.shellText(code.text, { dir: state.dir }, hostShell ? depth : depth + 1);
        if (found !== null) return found;
        if (hostShell) continue;
      }
      const found = this.named(code.text, state.dir, program);
      if (found !== null) return found;
    }
    if (call.inPlace) {
      for (const operand of call.operands) {
        const found = this.write(operand.text, state.dir, "file", `${program} -i editing ${operand.text}`);
        if (found !== null) return found;
      }
    }
    return null;
  }

  private sedInPlace(args: ReadonlyArray<Word>, state: ShellState): Deny | null {
    const inPlace = args.some(
      (a) => /^-[A-Za-z]*i/.test(a.text) || a.text === "--in-place" || a.text.startsWith("--in-place="),
    );
    if (!inPlace) return null;
    const scripted = args.some((a) => /^-[A-Za-z]*[ef]/.test(a.text) || /^--(expression|file)/.test(a.text));
    const operands = operandsOf(args, ["-e", "-f", "-l", "--expression", "--file"]);
    for (const operand of scripted ? operands : operands.slice(1)) {
      const found = this.write(operand.text, state.dir, "file", `sed -i editing ${operand.text}`);
      if (found !== null) return found;
    }
    return null;
  }

  private writeCommand(program: string, args: ReadonlyArray<Word>, state: ShellState): Deny | null {
    let targets: Word[] = [];
    let touch: Touch = "tree";
    const all = ALL_OPERANDS.get(program);
    const last = LAST_OPERAND.get(program);
    if (all !== undefined) {
      targets = [...operandsOf(args, all), ...optionValues(args, ["-t"], ["--target-directory"])];
      if (program === "tee") touch = "file";
    } else if (last !== undefined) {
      const operands = operandsOf(args, last);
      const directory = optionValues(args, ["-t"], ["--target-directory"]);
      const lastOperand = operands[operands.length - 1];
      targets =
        directory.length > 0 ? directory : operands.length > 1 && lastOperand !== undefined ? [lastOperand] : [];
    } else if (program === "dd") {
      targets = args.flatMap((a) => (a.text.startsWith("of=") ? [{ ...a, text: a.text.slice(3) }] : []));
      touch = "file";
    } else if (program === "curl") {
      targets = optionValues(args, ["-o"], ["--output"]);
      touch = "file";
    } else if (program === "wget") {
      targets = [
        ...optionValues(args, ["-O"], ["--output-document"]),
        ...optionValues(args, ["-P"], ["--directory-prefix"]),
      ];
    }
    for (const target of targets) {
      const found = this.write(target.text, state.dir, touch, `${program} ${target.text}`);
      if (found !== null) return found;
    }
    return null;
  }
}
