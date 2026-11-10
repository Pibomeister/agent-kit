/**
 * T3 adapter-integration evidence template (plan §3, §8 / GAP-13).
 *
 * Native traces qualify a host. This writer emits the evidence document with
 * empty discovery, slash, readonly and isolation slots and a not-qualified
 * verdict. It never fills a slot and never sets strict. Host ids that are not
 * packaging hosts, or that are not directories under adapters/, are rejected.
 * Support adapters such as tracker are not hosts.
 *
 * There is no reader that turns filled slots into a verdict. A later writer
 * that records real traces still needs a scorer. Until that exists every
 * successful run stays not-qualified.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_IDS } from "../packaging/hosts.ts";

export const T3_SLOTS = ["discovery", "slash", "readonly", "isolation"] as const;
export type T3SlotId = (typeof T3_SLOTS)[number];

export interface T3TraceSlot {
  readonly id: T3SlotId;
  readonly path: string | null;
  readonly sha256: string | null;
  readonly recordedAt: string | null;
}

export interface T3Evidence {
  readonly kind: "t3-evidence-template";
  readonly host: string;
  readonly adapter: string;
  readonly traces: readonly T3TraceSlot[];
  readonly verdict: "not-qualified";
  readonly strict: false;
  readonly reason: string;
}

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

export function isAdapterHost(host: string, repo: string = REPO): boolean {
  if (!HOST_IDS.some((id) => id === host)) return false;
  try {
    return statSync(join(repo, "adapters", host)).isDirectory();
  } catch {
    return false;
  }
}

export function emptyTraceSlot(id: T3SlotId): T3TraceSlot {
  return { id, path: null, sha256: null, recordedAt: null };
}

export function qualifyT3(host: string, repo: string = REPO): T3Evidence | null {
  if (!isAdapterHost(host, repo)) return null;
  const traces = T3_SLOTS.map(emptyTraceSlot);
  return {
    kind: "t3-evidence-template",
    host,
    adapter: `adapters/${host}`,
    traces,
    verdict: "not-qualified",
    strict: false,
    reason: "native traces are absent; empty slots are not a pass and do not admit strict support",
  };
}
