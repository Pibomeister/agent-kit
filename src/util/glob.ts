/** The host's glob-to-RegExp conversion: `**` any depth, `*` within one segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  const special = new Set(".+^${}()|[]\\");
  let out = "^";
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
    } else if (ch === "?") out += ".";
    else if (special.has(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return new RegExp(`${out}$`);
}
