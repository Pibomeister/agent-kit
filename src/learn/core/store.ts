/**
 * Small file helpers for ledger state: JSON, JSON Lines, timestamps, token estimate,
 * and the secret gate every recorded text passes before it is written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type SecretCounts, scrubJsonText, scrubSecrets } from "./secrets.ts";

export function nowIso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** UTC calendar date, `YYYY-MM-DD`. */
export function todayUtc(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Local calendar date, `YYYY-MM-DD`. The nightly job keys on the machine's own day. */
export function todayLocal(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function nowMs(): number {
  return Date.now();
}

/** Coarse token estimate: four characters per token. Good enough for a cap, never for billing. */
export function tokens(text: string): number {
  return Math.floor(text.length / 4);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** With `gate`, the JSON passes the secret gate first (`gateJsonText`). */
export function writeJson(path: string, data: unknown, gate?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(data, null, 1);
  writeFileSync(path, gate === undefined ? json : gateJsonText(gate, path, json));
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() !== "") out.push(JSON.parse(line) as T);
  }
  return out;
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** With `gate`, the rows pass the secret gate first (`gateJsonText`). */
export function appendJsonl(path: string, rows: readonly unknown[], gate?: string): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const lines = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  appendFileSync(path, gate === undefined ? lines : gateJsonText(gate, path, lines));
}

export function readText(path: string, fallback = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

// --- the secret gate ---------------------------------------------------------

/**
 * Where the gate records each redaction, relative to the ledger (or the runtime
 * directory) the written file belongs to. Raw and append-only: a rollback of
 * the text never removes the record that something was taken out of it.
 */
export const SECRET_REDACTIONS_FILE = "raw/secret-redactions.jsonl";

export interface RedactionRecord {
  at: string;
  /** The gated file, relative to the gate directory. */
  file: string;
  /** How many of each kind were replaced. Never the value. */
  kinds: SecretCounts;
}

function recordRedactions(gate: string, path: string, found: SecretCounts): void {
  if (Object.keys(found).length === 0) return;
  const row: RedactionRecord = { at: nowIso(), file: relative(gate, path), kinds: found };
  appendJsonl(join(gate, SECRET_REDACTIONS_FILE), [row]);
}

/**
 * The secret gate over text about to be written to `path`: credentials and home
 * paths become `[redacted:<kind>]` (`secrets.ts`), and a redaction is recorded
 * under `gate`, the ledger or runtime directory the file belongs to.
 */
export function gateText(gate: string, path: string, text: string): string {
  const { text: clean, found } = scrubSecrets(text);
  recordRedactions(gate, path, found);
  return clean;
}

/** `gateText` over serialized JSON, one string literal at a time (`scrubJsonText`). */
export function gateJsonText(gate: string, path: string, json: string): string {
  const { text: clean, found } = scrubJsonText(json);
  recordRedactions(gate, path, found);
  return clean;
}

/** `writeFileSync` behind the secret gate. */
export function writeGated(gate: string, path: string, text: string): void {
  writeFileSync(path, gateText(gate, path, text));
}

/** `appendFileSync` behind the secret gate. */
export function appendGated(gate: string, path: string, text: string): void {
  appendFileSync(path, gateText(gate, path, text));
}
