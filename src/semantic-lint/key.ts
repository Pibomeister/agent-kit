/** The one strict reader of the private key file, shared by the Stop hook and the doctor. */
import { lstatSync, readFileSync } from "node:fs";

/** Reads the private key file without following a symlink. Throws Error("auth") on any unsafe or malformed file. */
export function readKeyFile(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error("auth");
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    const match =
      /^(?:TYPESAFE_API_KEY|TYPESAFEAI_API_KEY)\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#'"`$]+))\s*$/.exec(
        line.trim(),
      );
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value !== undefined) return value;
  }
  throw new Error("auth");
}
