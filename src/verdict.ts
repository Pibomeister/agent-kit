/**
 * Strict parse of a seat or model verdict. One named field, exact enum match.
 * Prose mentions do not count. Missing, duplicated, conflicting, wrong-case
 * and unknown values fail closed.
 */

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

export const REJECT = "REJECT";

export const CLOSED_RATIONALE = "ambiguous or missing verdict";

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

export type ParsedVerdict<T extends string> =
  | { status: "exact"; value: T; object: JsonObject }
  | { status: "closed"; reason: string };

const ajv = new Ajv2020({ strict: false });
const isJsonValue: ValidateFunction<JsonValue> = ajv.compile({
  $defs: {
    value: {
      anyOf: [
        { type: "string" },
        { type: "number" },
        { type: "boolean" },
        { type: "null" },
        { type: "array", items: { $ref: "#/$defs/value" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/value" } },
      ],
    },
  },
  $ref: "#/$defs/value",
});
const isJsonObject: ValidateFunction<JsonObject> = ajv.compile({ type: "object" });
const isJsonString: ValidateFunction<string> = ajv.compile({ type: "string" });

function skipWs(source: string, i: number): number {
  while (i < source.length && (source[i] === " " || source[i] === "\t" || source[i] === "\n" || source[i] === "\r"))
    i += 1;
  return i;
}

function scanString(source: string, i: number): number | null {
  i += 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      if (source[i + 1] === "u") i += 6;
      else i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return null;
}

function scanNumber(source: string, i: number): number | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
  return match === null ? null : i + match[0].length;
}

function scanValue(source: string, i: number): number | null {
  i = skipWs(source, i);
  const c = source[i];
  if (c === undefined) return null;
  if (c === '"') return scanString(source, i);
  if (c === "{") return scanObject(source, i)?.end ?? null;
  if (c === "[") return scanArray(source, i);
  if (c === "t" && source.startsWith("true", i)) return i + 4;
  if (c === "f" && source.startsWith("false", i)) return i + 5;
  if (c === "n" && source.startsWith("null", i)) return i + 4;
  if (c === "-" || (c >= "0" && c <= "9")) return scanNumber(source, i);
  return null;
}

function scanArray(source: string, i: number): number | null {
  i = skipWs(source, i + 1);
  if (source[i] === "]") return i + 1;
  while (i < source.length) {
    const end = scanValue(source, i);
    if (end === null) return null;
    i = skipWs(source, end);
    if (source[i] === ",") {
      i += 1;
      continue;
    }
    return source[i] === "]" ? i + 1 : null;
  }
  return null;
}

function decodeJson(source: string): JsonValue | null {
  try {
    // SAFETY: JSON.parse is any; isJsonValue is the contract before use.
    const parsed: unknown = JSON.parse(source);
    return isJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function scanObject(source: string, i: number): { end: number; keys: string[] } | null {
  const keys: string[] = [];
  i = skipWs(source, i + 1);
  if (source[i] === "}") return { end: i + 1, keys };
  while (i < source.length) {
    i = skipWs(source, i);
    if (source[i] !== '"') return null;
    const keyEnd = scanString(source, i);
    if (keyEnd === null) return null;
    const key = decodeJson(source.slice(i, keyEnd));
    if (!isJsonString(key)) return null;
    keys.push(key);
    i = skipWs(source, keyEnd);
    if (source[i] !== ":") return null;
    const valueEnd = scanValue(source, i + 1);
    if (valueEnd === null) return null;
    i = skipWs(source, valueEnd);
    if (source[i] === ",") {
      i += 1;
      continue;
    }
    return source[i] === "}" ? { end: i + 1, keys } : null;
  }
  return null;
}

function closed<T extends string>(reason: string): ParsedVerdict<T> {
  return { status: "closed", reason };
}

/** Quoted, newline-safe echo of model text in a closed reason, capped at 64 characters. */
function echo(value: string): string {
  return JSON.stringify(value).slice(0, 64);
}

/**
 * The value of `field` in `source`. The trimmed source must be exactly one
 * JSON object, the key may appear once, and the value must be an exact
 * member of `allowed`. Prose around the object is not a parse.
 */
export function parseVerdict<T extends string>(source: string, field: string, allowed: readonly T[]): ParsedVerdict<T> {
  const trimmed = source.trim();
  const scanned = trimmed.startsWith("{") ? scanObject(trimmed, 0) : null;
  if (scanned === null || scanned.end !== trimmed.length) return closed("not a JSON object");
  const object = decodeJson(trimmed);
  if (!isJsonObject(object)) return closed("not a JSON object");
  if (!scanned.keys.includes(field)) return closed(`missing ${field}`);
  const seen = new Set<string>();
  for (const key of scanned.keys) {
    if (seen.has(key)) return closed(key === field ? `conflicting ${field}` : `duplicate key ${echo(key)}`);
    seen.add(key);
  }
  const value = object[field];
  if (!isJsonString(value)) return closed(`${field} is not a string`);
  const match = allowed.find((item) => item === value);
  if (match === undefined) return closed(`${field} ${echo(value)} is not in the enum`);
  return { status: "exact", value: match, object };
}

export function invalidAnswerError(parsed: ParsedVerdict<string>, kind: "answer" | "judgment"): string {
  const base = `launcher returned an invalid ${kind}`;
  return parsed.status === "closed" ? `${base}: ${parsed.reason}` : base;
}

/** REJECT after the substitute chain produced no valid answer, when that is an option. */
export function exhaustedReject(options: readonly string[]): { choice: string; rationale: string } | null {
  return options.includes(REJECT) ? { choice: REJECT, rationale: CLOSED_RATIONALE } : null;
}
