import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isFiniteNumber } from "./parse.ts";
import { isEventArray, type Event } from "./types.ts";

export interface CorpusEntry {
  /** fast-check seed; optional when the entry is a stored sequence. */
  seed?: number;
  path?: string;
  events: Event[];
  /**
   * When true, this sequence is a documented product disagreement: the suite
   * still runs it and requires it to fail for `expectedFailure`. A later fix
   * that makes it pass must remove the entry.
   */
  knownFailure: boolean;
  /** Distinctive failure string the suite must match when `knownFailure` is true. */
  expectedFailure?: string;
  note: string;
}

export const CORPUS_PATH = join(import.meta.dir, "corpus", "seeds.json");

function isObject(value: unknown): value is object {
  return value !== null && !Array.isArray(value) && value instanceof Object;
}

function isNonemptyJsonString(value: unknown): value is string {
  if (value === true || value === false || value === null) return false;
  if (Number.isFinite(value) || Array.isArray(value) || value instanceof Object) return false;
  const quoted = JSON.stringify(value);
  return quoted.startsWith('"') && quoted.length > 2;
}

export function loadCorpus(): CorpusEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  if (!isObject(parsed) || !("version" in parsed) || !("seeds" in parsed) || !Array.isArray(parsed.seeds)) {
    throw new Error(`${CORPUS_PATH} is not a corpus file`);
  }
  const seeds: unknown[] = parsed.seeds;
  const out: CorpusEntry[] = [];
  for (const [index, item] of seeds.entries()) {
    if (!isObject(item)) throw new Error(`${CORPUS_PATH} seeds[${index}] is not an object`);
    if (!("events" in item) || !isEventArray(item.events)) {
      throw new Error(`${CORPUS_PATH} seeds[${index}].events is not an array of Event kinds`);
    }
    if (!("knownFailure" in item) || (item.knownFailure !== true && item.knownFailure !== false)) {
      throw new Error(`${CORPUS_PATH} seeds[${index}].knownFailure must be a boolean`);
    }
    if (!("note" in item) || !isNonemptyJsonString(item.note)) {
      throw new Error(`${CORPUS_PATH} seeds[${index}].note must be a nonempty string`);
    }
    const knownFailure = item.knownFailure;
    const entry: CorpusEntry = { events: item.events, knownFailure, note: item.note };
    if ("seed" in item && isFiniteNumber(item.seed)) entry.seed = item.seed;
    if ("path" in item && isNonemptyJsonString(item.path)) entry.path = item.path;
    if (knownFailure) {
      if (!("expectedFailure" in item) || !isNonemptyJsonString(item.expectedFailure)) {
        throw new Error(`${CORPUS_PATH} seeds[${index}].expectedFailure is required when knownFailure is true`);
      }
      entry.expectedFailure = item.expectedFailure;
    }
    out.push(entry);
  }
  return out;
}
