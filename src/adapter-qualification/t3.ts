/**
 * T3 adapter-integration evidence (plan §3, §8 / GAP-13).
 *
 * Native traces qualify a host. This writer emits the evidence document with
 * empty discovery, slash, readonly and isolation slots and a not-qualified
 * verdict. It never fills a slot and never sets strict. A later live session
 * that records real traces is a different writer.
 */
export const T3_SLOTS = ["discovery", "slash", "readonly", "isolation"] as const;
export type T3SlotId = (typeof T3_SLOTS)[number];

export interface T3TraceSlot {
  readonly id: T3SlotId;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly recordedAt: string | null;
}

export interface T3Evidence {
  readonly host: string;
  readonly adapter: string;
  readonly traces: readonly T3TraceSlot[];
  readonly verdict: "not-qualified";
  readonly strict: false;
  readonly reason: string;
}

export function isT3HostId(value: string): boolean {
  if (value === "") return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const lower = code >= 97 && code <= 122;
    const digit = code >= 48 && code <= 57;
    const dash = code === 45;
    if (!lower && !digit && !dash) return false;
  }
  return true;
}

export function emptyTraceSlot(id: T3SlotId): T3TraceSlot {
  return { id, path: null, sha256: null, recordedAt: null };
}

export function qualifyT3(host: string): T3Evidence | null {
  if (!isT3HostId(host)) return null;
  const traces = T3_SLOTS.map(emptyTraceSlot);
  return {
    host,
    adapter: `adapters/${host}`,
    traces,
    verdict: "not-qualified",
    strict: false,
    reason: "native traces are absent; empty slots are not a pass and do not admit strict support",
  };
}
