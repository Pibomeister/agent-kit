/** JSON documents as typed values, for tests that corrupt one member of a valid document at a time. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Path = (string | number)[];

/** JSON text as a typed value: the reviver sees the parsed root under the empty key. */
export function parseJson(text: string): JsonValue {
  let root: JsonValue = null;
  JSON.parse(text, (key: string, value: JsonValue) => {
    if (key === "") root = value;
    return value;
  });
  return root;
}

function membersOf(value: JsonValue): [string | number, JsonValue][] {
  if (Array.isArray(value)) return value.map((child, i) => [i, child]);
  if (value instanceof Object) return Object.entries(value);
  return [];
}

/** Every member path in the document, nested ones included. */
export function pathsOf(value: JsonValue, at: Path): Path[] {
  return membersOf(value).flatMap(([key, child]) => [[...at, key], ...pathsOf(child, [...at, key])]);
}

/**
 * A copy of `value` whose member at `path` is `change(current)`. Returning `undefined` deletes the member,
 * and a member the path names that does not exist yet is added.
 */
export function updated(
  value: JsonValue,
  path: Path,
  change: (current: JsonValue | undefined) => JsonValue | undefined,
): JsonValue {
  const [step, ...rest] = path;
  if (step === undefined) return change(value) ?? null;
  const next = (child: JsonValue | undefined) =>
    rest.length === 0 ? change(child) : updated(child ?? {}, rest, change);
  if (Array.isArray(value))
    return value.flatMap((child, i) => {
      if (i !== step) return [child];
      const replacement = next(child);
      return replacement === undefined ? [] : [replacement];
    });
  if (value instanceof Object) {
    const key = String(step);
    const others = Object.entries(value).filter(([member]) => member !== key);
    const replacement = next(Object.entries(value).find(([member]) => member === key)?.[1]);
    return Object.fromEntries(replacement === undefined ? others : [...others, [key, replacement]]);
  }
  return value;
}

/** A string becomes a number; anything else becomes a string. Either way the member has the wrong type. */
function retyped(value: JsonValue): JsonValue {
  return JSON.stringify(value).startsWith('"') ? 7 : "x";
}

/** A copy of `value` with the member at `path` deleted, nulled, retyped or emptied to `[]`. */
export function edited(value: JsonValue, path: Path, how: "delete" | "null" | "retype" | "empty"): JsonValue {
  return updated(value, path, (current) =>
    how === "delete" ? undefined : how === "null" ? null : how === "empty" ? [] : retyped(current ?? null),
  );
}
