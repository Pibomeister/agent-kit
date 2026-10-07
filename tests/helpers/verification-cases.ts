import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { edited, parseJson, pathsOf, updated, type JsonValue, type Path } from "./json.ts";

const ROOT = join(import.meta.dir, "..", "..");

function memberAt(value: JsonValue, path: Path): JsonValue {
  let current = value;
  for (const key of path) {
    const child = Array.isArray(current)
      ? current[Number(key)]
      : current instanceof Object
        ? current[String(key)]
        : undefined;
    if (child === undefined) throw new Error(`Missing fixture member ${path.join(".")}`);
    current = child;
  }
  return current;
}

/** One canonical population for the source/oracle sweep and the shipped-runtime sweep. */
export function verificationPopulations() {
  const paths = [
    ["verification.example.json", "templates/verification.example.json"],
    ["verification.surface.example.json", "templates/verification.surface.example.json"],
    ["verification.weakened.example.json", "templates/verification.weakened.example.json"],
    ["verification.zero-exit-failure.example.json", "templates/verification.zero-exit-failure.example.json"],
    ["all-members", "tests/fixtures/verification-all-members.json"],
  ];
  return paths.map(([name, relativePath]) => {
    if (name === undefined || relativePath === undefined) throw new Error("Missing fixture path");
    const bytes = readFileSync(join(ROOT, relativePath));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const doc = parseJson(bytes.toString("utf8"));
    const cases = [{ label: "unchanged", doc }];
    for (const member of pathsOf(doc)) {
      for (const how of ["delete", "null", "retype"] as const)
        cases.push({ label: `${how} ${member.join(".")}`, doc: edited(doc, member, how) });
      if (JSON.stringify(memberAt(doc, member)).startsWith('"'))
        for (const value of ["", " ", "../escape", "/absolute", "Jan 1 2026", "invalid", "a".repeat(129)])
          cases.push({
            label: `string ${member.join(".")}=${JSON.stringify(value)}`,
            doc: updated(doc, member, () => value),
          });
    }
    for (const objectPath of [[], ...pathsOf(doc)]) {
      const member = memberAt(doc, objectPath);
      if (!(member instanceof Object) || Array.isArray(member)) continue;
      cases.push({
        label: `unknown member ${objectPath.join(".")}`,
        doc: updated(doc, [...objectPath, "unknown_member"], () => true),
      });
    }
    return { name, hash, doc, cases };
  });
}
