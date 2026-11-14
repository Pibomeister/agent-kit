/** The host's glob-to-RegExp conversion: `**` any depth, `*` within one segment, `?` one character that is not a slash; `**` also spans newlines, which a path may hold. */
export function globToRegExp(glob: string): RegExp {
  const special = new Set(".+^${}()|[]\\");
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob.charAt(i + 1) === "*") {
        if (glob.charAt(i + 2) === "/") {
          out += "(?:[\\s\\S]*/)?";
          i += 2;
        } else {
          out += "[\\s\\S]*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (special.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`${out}$`);
}
