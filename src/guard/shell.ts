/**
 * A POSIX-shell lexer for the guard evaluator: enough of the grammar to find
 * every simple command, its words, its redirections and where its standard
 * input comes from, without running anything.
 *
 * It does not expand. A word's literal text is kept, and each run-time part of
 * it ($VAR, ${...}, $(...), backticks, $((...))) is replaced by DYNAMIC, or by
 * HOME for `~` and `$HOME`, so the evaluator can tell a fixed path from one it
 * cannot know. The text of every command substitution, process substitution
 * and expanding heredoc body is returned in `nested`, so the caller judges it
 * as shell too. Text that does not lex (an unterminated quote or
 * substitution) returns null, which the evaluator denies as unjudgeable.
 */
export const DYNAMIC = "\u0000";
export const HOME = "\u0001";

export interface Word {
  text: string;
  /** Some part of the word is only known at run time. */
  dynamic: boolean;
  /** Some part of the word was quoted, which makes a heredoc delimiter literal. */
  quoted: boolean;
}

export interface Redirect {
  op: string;
  target: Word;
}

export type Stdin =
  | { kind: "terminal" }
  | { kind: "pipe" }
  | { kind: "file" }
  | { kind: "text"; text: string; dynamic: boolean };

export interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
  stdin: Stdin;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  nested: string[];
}

const OPERATOR_CHARS = new Set([";", "&", "|", "(", ")", "<", ">"]);
const BLANK = new Set([" ", "\t"]);

interface Heredoc {
  command: SimpleCommand;
  delimiter: string;
  stripTabs: boolean;
  expands: boolean;
}

function newCommand(stdin: Stdin): SimpleCommand {
  return { words: [], redirects: [], stdin };
}

/** Index of the `)` matching the `(` at `open`, or -1. Quotes and nested substitutions are skipped. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === "\\") i += 1;
    else if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (ch === '"') {
      const close = matchDoubleQuote(src, i);
      if (close < 0) return -1;
      i = close;
    } else if (ch === "`") {
      const close = matchBacktick(src, i);
      if (close < 0) return -1;
      i = close;
    } else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchDoubleQuote(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === "\\") i += 1;
    else if (ch === '"') return i;
    else if (ch === "$" && src.charAt(i + 1) === "(") {
      const close = matchParen(src, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (ch === "`") {
      const close = matchBacktick(src, i);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

function matchBacktick(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === "\\") i += 1;
    else if (ch === "`") return i;
  }
  return -1;
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === "\\") i += 1;
    else if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (ch === '"') {
      const close = matchDoubleQuote(src, i);
      if (close < 0) return -1;
      i = close;
    } else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const ANSI_ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
  ["0", ""],
  ["a", "\u0007"],
  ["e", "\u001b"],
]);

/**
 * Every command substitution in text that expands like a double-quoted
 * string: an unquoted heredoc body, or the inside of `${...}`. Null when one
 * does not close.
 */
export function substitutionsIn(text: string): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\\") i += 1;
    else if (ch === "$" && text.charAt(i + 1) === "(" && text.charAt(i + 2) !== "(") {
      const close = matchParen(text, i + 1);
      if (close < 0) return null;
      out.push(text.slice(i + 2, close));
      i = close;
    } else if (ch === "`") {
      const close = matchBacktick(text, i);
      if (close < 0) return null;
      out.push(text.slice(i + 1, close).replaceAll("\\`", "`"));
      i = close;
    }
  }
  return out;
}

class Lexer {
  private readonly src: string;
  private i = 0;
  private readonly commands: SimpleCommand[] = [];
  private readonly nested: string[] = [];
  private current: SimpleCommand = newCommand({ kind: "terminal" });
  private pendingRedirect: string | null = null;
  private heredocs: Heredoc[] = [];

  constructor(src: string) {
    this.src = src;
  }

  run(): ParsedShell | null {
    const src = this.src;
    while (this.i < src.length) {
      const ch = src.charAt(this.i);
      if (BLANK.has(ch)) {
        this.i += 1;
      } else if (ch === "\\" && src.charAt(this.i + 1) === "\n") {
        this.i += 2;
      } else if (ch === "\n") {
        this.i += 1;
        if (!this.endCommand({ kind: "terminal" })) return null;
        if (!this.readHeredocBodies()) return null;
      } else if (ch === "#") {
        const end = src.indexOf("\n", this.i);
        this.i = end < 0 ? src.length : end;
      } else if ((ch === "<" || ch === ">") && src.charAt(this.i + 1) === "(") {
        if (!this.readWord()) return null;
      } else if (ch === "<" || ch === ">" || (ch === "&" && src.charAt(this.i + 1) === ">")) {
        if (!this.readRedirectOp()) return null;
      } else if (OPERATOR_CHARS.has(ch)) {
        if (!this.readControlOp()) return null;
      } else if (!this.readWord()) return null;
    }
    if (!this.endCommand({ kind: "terminal" })) return null;
    // A heredoc with no terminating line runs to the end of the text, as bash reads it.
    for (const doc of this.heredocs) {
      if (!this.attachHeredoc(doc, "")) return null;
    }
    return { commands: this.commands, nested: this.nested };
  }

  private endCommand(next: Stdin): boolean {
    if (this.pendingRedirect !== null) return false;
    const c = this.current;
    if (c.words.length > 0 || c.redirects.length > 0) this.commands.push(c);
    this.current = newCommand(next);
    return true;
  }

  private readControlOp(): boolean {
    const src = this.src;
    const ch = src.charAt(this.i);
    const two = src.slice(this.i, this.i + 2);
    if (two === "|&" || (ch === "|" && two !== "||")) {
      this.i += two === "|&" ? 2 : 1;
      return this.endCommand({ kind: "pipe" });
    }
    this.i += two === "&&" || two === "||" || two === ";;" || two === ";&" ? 2 : 1;
    return this.endCommand({ kind: "terminal" });
  }

  private readRedirectOp(): boolean {
    if (this.pendingRedirect !== null) return false;
    const src = this.src;
    for (const op of ["&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<&", "<>", "<<", ">", "<"]) {
      if (src.startsWith(op, this.i)) {
        this.i += op.length;
        this.pendingRedirect = op;
        return true;
      }
    }
    return false;
  }

  private readWord(): boolean {
    const src = this.src;
    let text = "";
    let dynamic = false;
    let quoted = false;
    const start = this.i;
    while (this.i < src.length) {
      const ch = src.charAt(this.i);
      if (BLANK.has(ch) || ch === "\n") break;
      if ((ch === "<" || ch === ">") && src.charAt(this.i + 1) === "(") {
        const close = matchParen(src, this.i + 1);
        if (close < 0) return false;
        this.nested.push(src.slice(this.i + 2, close));
        text += DYNAMIC;
        dynamic = true;
        this.i = close + 1;
        continue;
      }
      if (ch === "<" || ch === ">") {
        // `2>file`: digits immediately before a redirection are its descriptor.
        if (!quoted && /^[0-9]+$/.test(text) && this.i - start === text.length) return true;
        break;
      }
      if (OPERATOR_CHARS.has(ch)) break;
      if (ch === "\\") {
        if (src.charAt(this.i + 1) === "\n") this.i += 2;
        else {
          text += src.charAt(this.i + 1);
          quoted = true;
          this.i += 2;
        }
      } else if (ch === "'") {
        const close = src.indexOf("'", this.i + 1);
        if (close < 0) return false;
        text += src.slice(this.i + 1, close);
        quoted = true;
        this.i = close + 1;
      } else if (ch === '"') {
        const part = this.readDoubleQuoted();
        if (part === null) return false;
        text += part.text;
        dynamic ||= part.dynamic;
        quoted = true;
      } else if (ch === "$" && src.charAt(this.i + 1) === "'") {
        const part = this.readAnsiQuoted();
        if (part === null) return false;
        text += part;
        quoted = true;
      } else if (ch === "$" && src.charAt(this.i + 1) === '"') {
        this.i += 1;
      } else if (ch === "$" || ch === "`") {
        const part = this.readExpansion();
        if (part === null) return false;
        text += part.text;
        dynamic ||= part.dynamic;
      } else if (ch === "~" && this.i === start && /^(\/|$|[\s;&|<>()])/.test(src.slice(this.i + 1, this.i + 2))) {
        text += HOME;
        this.i += 1;
      } else {
        // Text handed back for a second lex keeps its run-time parts marked.
        if (ch === DYNAMIC) dynamic = true;
        text += ch;
        this.i += 1;
      }
    }
    return this.finishWord({ text, dynamic, quoted });
  }

  private readDoubleQuoted(): { text: string; dynamic: boolean } | null {
    const src = this.src;
    let text = "";
    let dynamic = false;
    this.i += 1;
    while (this.i < src.length) {
      const ch = src.charAt(this.i);
      if (ch === '"') {
        this.i += 1;
        return { text, dynamic };
      }
      if (ch === "\\") {
        const next = src.charAt(this.i + 1);
        if (next === "\n") {
          this.i += 2;
          continue;
        }
        text += '$`"\\'.includes(next) ? next : `\\${next}`;
        this.i += 2;
      } else if (ch === "$" || ch === "`") {
        const part = this.readExpansion();
        if (part === null) return null;
        text += part.text;
        dynamic ||= part.dynamic;
      } else {
        if (ch === DYNAMIC) dynamic = true;
        text += ch;
        this.i += 1;
      }
    }
    return null;
  }

  private readAnsiQuoted(): string | null {
    const src = this.src;
    let text = "";
    this.i += 2;
    while (this.i < src.length) {
      const ch = src.charAt(this.i);
      if (ch === "'") {
        this.i += 1;
        return text;
      }
      if (ch === "\\") {
        const next = src.charAt(this.i + 1);
        text += ANSI_ESCAPES.get(next) ?? next;
        this.i += 2;
      } else {
        text += ch;
        this.i += 1;
      }
    }
    return null;
  }

  /** At a `$` or a backtick. */
  private readExpansion(): { text: string; dynamic: boolean } | null {
    const src = this.src;
    const ch = src.charAt(this.i);
    if (ch === "`") {
      const close = matchBacktick(src, this.i);
      if (close < 0) return null;
      this.nested.push(src.slice(this.i + 1, close).replaceAll("\\`", "`"));
      this.i = close + 1;
      return { text: DYNAMIC, dynamic: true };
    }
    const next = src.charAt(this.i + 1);
    if (next === "(") {
      const close = matchParen(src, this.i + 1);
      if (close < 0) return null;
      // `$((...))` is arithmetic and runs nothing; `$(...)` is a command.
      if (src.charAt(this.i + 2) !== "(") this.nested.push(src.slice(this.i + 2, close));
      this.i = close + 1;
      return { text: DYNAMIC, dynamic: true };
    }
    if (next === "{") {
      const close = matchBrace(src, this.i + 1);
      if (close < 0) return null;
      const body = src.slice(this.i + 2, close);
      const inner = substitutionsIn(body);
      if (inner === null) return null;
      this.nested.push(...inner);
      this.i = close + 1;
      return { text: body === "HOME" ? HOME : DYNAMIC, dynamic: body !== "HOME" };
    }
    const name = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(this.i + 1));
    if (name === null) {
      this.i += 1;
      return { text: "$", dynamic: false };
    }
    this.i += 1 + name[0].length;
    return name[0] === "HOME" ? { text: HOME, dynamic: false } : { text: DYNAMIC, dynamic: true };
  }

  private finishWord(word: Word): boolean {
    const op = this.pendingRedirect;
    if (op === null) {
      this.current.words.push(word);
      return true;
    }
    this.pendingRedirect = null;
    if (op === "<<" || op === "<<-") {
      this.heredocs.push({
        command: this.current,
        delimiter: word.text,
        stripTabs: op === "<<-",
        expands: !word.quoted,
      });
      return true;
    }
    if (op === "<<<") {
      this.current.stdin = { kind: "text", text: word.text, dynamic: word.dynamic };
      return true;
    }
    if (op === "<" || op === "<&") this.current.stdin = { kind: "file" };
    this.current.redirects.push({ op, target: word });
    return true;
  }

  private readHeredocBodies(): boolean {
    const src = this.src;
    const docs = this.heredocs;
    this.heredocs = [];
    for (const doc of docs) {
      const lines: string[] = [];
      let closed = false;
      while (this.i < src.length) {
        const end = src.indexOf("\n", this.i);
        const raw = src.slice(this.i, end < 0 ? src.length : end);
        this.i = end < 0 ? src.length : end + 1;
        const line = doc.stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (line === doc.delimiter) {
          closed = true;
          break;
        }
        lines.push(line);
      }
      const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      if (!this.attachHeredoc(doc, body)) return false;
      if (!closed) return true;
    }
    return true;
  }

  private attachHeredoc(doc: Heredoc, body: string): boolean {
    let dynamic = false;
    if (doc.expands) {
      const inner = substitutionsIn(body);
      if (inner === null) return false;
      this.nested.push(...inner);
      dynamic = inner.length > 0 || /\$[A-Za-z_{]/.test(body);
    }
    doc.command.stdin = { kind: "text", text: body, dynamic };
    return true;
  }
}

/** Lex shell text into its simple commands, or null when it does not lex. */
export function parseShell(src: string): ParsedShell | null {
  return new Lexer(src).run();
}
