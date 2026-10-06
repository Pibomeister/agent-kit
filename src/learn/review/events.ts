/**
 * The review loop's raw layer: one JSON line per review event, append-only,
 * deduplicated by a hash of its source and a stable key.
 *
 * Reviewer text is data. Nothing here executes or interprets it; the only
 * reading it gets is severity parsing and HTML stripping.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Ledger } from "../core/ledger.ts";
import { appendJsonl, readJsonl } from "../core/store.ts";
import { EVENTS_FILE } from "./ledger.ts";

/** A finding raises a problem; a resolution answers one; a correction is a user correcting the agent. */
export type EventKind = "finding" | "resolution" | "correction";

export interface ReviewEvent {
  /** `github`, `github-reply`, `author-reply`, `review-report`, `claude-mem` or `correction`. */
  source: string;
  kind: EventKind;
  project: string | null;
  pr: number | null;
  sha: string | null;
  author: string | null;
  /** `P0`..`P3` when the text carries one. */
  severity: string | null;
  path: string | null;
  line: number | null;
  text: string;
  url: string | null;
  ts: string | null;
  platform: string;
  hash: string;
  /** For a reply: the hash of the finding it answers. */
  in_reply_to?: string;
  /** For a claude-mem event: the observation id. */
  obs_id?: number;
  /** For a correction: the detector's matched pattern names and confidence. */
  patterns?: string;
  confidence?: number;
}

/** sha1 over `source NUL key`, first 16 hex digits. Stable across runs, so re-ingesting is a no-op. */
export function eventHash(source: string, key: string): string {
  return createHash("sha1").update(`${source}\u0000${key}`, "utf8").digest("hex").slice(0, 16);
}

export type EventFields = Omit<ReviewEvent, "hash" | "platform"> & { platform?: string };

/** Build an event. The hash key is `key`, else the url, else the text. */
export function makeEvent(fields: EventFields, key?: string): ReviewEvent {
  const { platform, ...rest } = fields;
  return { ...rest, platform: platform ?? "claude", hash: eventHash(fields.source, key ?? fields.url ?? fields.text) };
}

const SEVERITY = /alt="(P[0-3])"|\b(P[0-3])\b/;

/** `P0`..`P3` from a badge's alt text or a bare token; null when absent. */
export function parseSeverity(body: string | null | undefined): string | null {
  const match = SEVERITY.exec(body ?? "");
  return match === null ? null : (match[1] ?? match[2] ?? null);
}

export function stripHtml(body: string | null | undefined): string {
  return (body ?? "").replace(/<[^>]+>/g, "").trim();
}

export function loadEvents(ledger: Ledger): ReviewEvent[] {
  return readJsonl<ReviewEvent>(ledger.path(EVENTS_FILE));
}

/** Append the events whose hash is unseen, in order. Returns how many were appended. */
export function appendEvents(ledger: Ledger, events: readonly ReviewEvent[]): number {
  const seen = new Set(loadEvents(ledger).map((event) => event.hash));
  const fresh: ReviewEvent[] = [];
  for (const event of events) {
    if (seen.has(event.hash)) continue;
    seen.add(event.hash);
    fresh.push(event);
  }
  appendJsonl(ledger.path(EVENTS_FILE), fresh, ledger.dir);
  return fresh.length;
}

/** A raw file's exact bytes, or null when it does not exist. Rollback uses it to keep the raw layer append-only. */
export function rawSnapshot(ledger: Ledger, file: string = EVENTS_FILE): Buffer | null {
  const path = ledger.path(file);
  return existsSync(path) ? readFileSync(path) : null;
}
