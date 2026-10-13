/**
 * The policy's glob dialect (schemas/common.schema.json `glob`): `*` and `?`
 * stay inside one path segment, `**` crosses segments, `{a,b}` alternates and
 * may nest. Every other character is literal, `[` included.
 */
export interface CompiledGlob {
  source: string;
  regex: RegExp;
  /** The segments before the first one holding a wildcard or an alternation. */
  literalPrefix: ReadonlyArray<string>;
  /** Whether the glob begins with `**`, the form that also matches outside the workspace. */
  floating: boolean;
}

const SPECIAL = new Set(".+^$()|[]\\");

/** Null when the braces do not balance. */
export function compileGlob(glob: string): CompiledGlob | null {
  let out = "^";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob.charAt(i + 1) === "*") {
        if (glob.charAt(i + 2) === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      depth += 1;
      out += "(?:";
    } else if (ch === "}") {
      if (depth === 0) return null;
      depth -= 1;
      out += ")";
    } else if (ch === "," && depth > 0) out += "|";
    else if (SPECIAL.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  if (depth !== 0) return null;
  const literalPrefix: string[] = [];
  for (const segment of glob.split("/")) {
    if (/[*?{]/.test(segment)) break;
    literalPrefix.push(segment);
  }
  return { source: glob, regex: new RegExp(`${out}$`), literalPrefix, floating: glob.startsWith("**") };
}

/** Whether a workspace-relative path, given as segments, is the glob's literal prefix or a directory above it. */
export function coversPrefix(glob: CompiledGlob, segments: ReadonlyArray<string>): boolean {
  if (segments.length > glob.literalPrefix.length) return false;
  return segments.every((segment, i) => segment === glob.literalPrefix[i]);
}
