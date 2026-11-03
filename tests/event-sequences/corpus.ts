import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Event } from "./types.ts";

export interface CorpusEntry {
  /** fast-check seed; optional when the entry is a stored sequence. */
  seed?: number;
  path?: string;
  events: Event[];
  /**
   * When true, this sequence is a documented product disagreement: the suite
   * still runs it and requires it to fail for `note`. A later fix that makes
   * it pass must remove the entry.
   */
  knownFailure: boolean;
  note: string;
}

interface CorpusFile {
  version: number;
  seeds: CorpusEntry[];
}

export const CORPUS_PATH = join(import.meta.dir, "corpus", "seeds.json");

export function loadCorpus(): CorpusEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  if (!isCorpusFile(parsed)) throw new Error(`${CORPUS_PATH} is not a corpus file`);
  return parsed.seeds;
}

function isCorpusFile(value: unknown): value is CorpusFile {
  if (value === null || Array.isArray(value) || !(value instanceof Object)) return false;
  if (!("version" in value) || !("seeds" in value)) return false;
  return Array.isArray(value.seeds);
}
