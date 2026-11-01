/**
 * The skill doctor's I/O boundary: host session records and judge replies are
 * decoded here, once, into JSON values with checked types. Every later step reads
 * the decoded value and never inspects a raw one.
 */
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import type { JudgeCallContext } from "../core/judge.ts";
import type { LearnContext } from "../core/context.ts";

type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const validator = new Ajv({ strict: false });
const validateJsonValue = validator.compile<JsonValue>({
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
const validateObject = validator.compile<JsonObject>({ type: "object" });
const validateArray = validator.compile<JsonValue[]>({ type: "array" });
const validateString = validator.compile<string>({ type: "string" });

/** `value` when it is a JSON object, else null. */
export function object(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined && validateObject(value) ? value : null;
}

/** `value` when it is a string, else null. */
export function text(value: JsonValue | undefined): string | null {
  return value !== undefined && validateString(value) ? value : null;
}

/** `value` when it is an array, else null. */
export function array(value: JsonValue | undefined): JsonValue[] | null {
  return value !== undefined && validateArray(value) ? value : null;
}

/** `value` when it is an array, else an empty one. */
export function items(value: JsonValue | undefined): JsonValue[] {
  return array(value) ?? [];
}

/** The objects in `value` when it is an array; anything else in it is skipped. */
export function objects(value: JsonValue | undefined): JsonObject[] {
  return items(value).flatMap((item) => {
    const found = object(item);
    return found === null ? [] : [found];
  });
}

/** One JSON document decoded, or null when it does not parse. */
export function parseJson(source: string): JsonValue | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return validateJsonValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A JSON object file decoded, or null when it is missing, unreadable or not an object. */
export function readObject(path: string): JsonObject | null {
  try {
    return object(parseJson(readFileSync(path, "utf8")) ?? undefined);
  } catch {
    return null;
  }
}

/** One judge call, its reply decoded to a JSON object; null when the call failed or the reply is not one. */
export function judgeObject(ctx: LearnContext, prompt: string, context: JudgeCallContext): JsonObject | null {
  const reply = ctx.judge(prompt, context);
  return reply !== null && validateJsonValue(reply) ? object(reply) : null;
}
