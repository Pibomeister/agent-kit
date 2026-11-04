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

interface ScannedObject {
  value: JsonObject;
  keys: string[];
}

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

function jsonObjects(source: string): ScannedObject[] {
  const objects: ScannedObject[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "{") {
      const scanned = scanObject(source, i);
      if (scanned !== null) {
        const value = decodeJson(source.slice(i, scanned.end));
        if (isJsonObject(value)) objects.push({ value, keys: scanned.keys });
        i = scanned.end;
        continue;
      }
    } else if (c === "[") {
      const end = scanArray(source, i);
      if (end !== null) {
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return objects;
}

function closed<T extends string>(reason: string): ParsedVerdict<T> {
  return { status: "closed", reason };
}

/**
 * The value of `field` in `source`. Exactly one JSON object may carry it, the
 * key may appear once, and the value must be an exact member of `allowed`.
 */
export function parseVerdict<T extends string>(source: string, field: string, allowed: readonly T[]): ParsedVerdict<T> {
  const hits = jsonObjects(source).filter((object) => object.keys.includes(field));
  const hit = hits[0];
  if (hit === undefined) return closed(`missing ${field}`);
  if (hits.length > 1) return closed(`duplicated ${field}`);
  if (new Set(hit.keys).size !== hit.keys.length) return closed(`conflicting ${field}`);
  if (hit.keys.filter((key) => key === field).length !== 1) return closed(`conflicting ${field}`);
  const value = hit.value[field];
  if (!isJsonString(value)) return closed(`${field} is not a string`);
  const match = allowed.find((item) => item === value);
  if (match === undefined) return closed(`${field} ${value} is not in the enum`);
  return { status: "exact", value: match, object: hit.value };
}

/**
 * A seat's `choice` field. Only an exact enum hit is a parse. Callers still
 * run the existing answer validators; an object that fails them is invalid.
 */
export function parseSeatVerdict(
  source: string,
  options: readonly string[],
): Extract<ParsedVerdict<string>, { status: "exact" }> | null {
  const parsed = parseVerdict(source, "choice", options);
  return parsed.status === "exact" ? parsed : null;
}

/** REJECT after the substitute chain produced no valid answer, when that is an option. */
export function exhaustedReject(options: readonly string[]): { choice: string; rationale: string } | null {
  return options.includes(REJECT) ? { choice: REJECT, rationale: CLOSED_RATIONALE } : null;
}
