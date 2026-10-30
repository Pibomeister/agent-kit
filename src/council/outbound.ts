/**
 * The council's outbound gate: what a seat receives leaves this host, so the
 * gate decides whether it may leave, and refuses rather than edits.
 *
 * There is no automatic screening. A seat receives only the card and the
 * context its caller named, and the gate refuses the whole payload on any of
 * three findings: a context path the deny-list names, a payload larger than
 * the cap, or a credential the secret patterns detect. Nothing is redacted,
 * because a redacted payload is a different payload than the one the caller
 * reviewed. The refusal names the finding and never the secret value.
 */

import { realpathSync } from "node:fs";
import { basename } from "node:path";

import { SECRET_KINDS, scrubSecrets, type SecretKind } from "../learn/core/secrets.ts";

/** The payload cap when a configuration names none: 256 KiB. */
export const DEFAULT_MAX_BYTES = 262_144;

/**
 * Path segments that never leave the host. Each entry matches one whole
 * segment of a context path; `*` matches any run of characters within it.
 */
export const BUILT_IN_DENY: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".git",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "credentials*",
  "secrets*",
];

/** A home path names an account, not a credential, so it does not refuse a payload. */
const REFUSING_KINDS: readonly SecretKind[] = SECRET_KINDS.filter((kind) => kind !== "home-path");

export interface OutboundItem {
  /** How the refusal names this item: a context path, or a fixed label such as `card`. */
  label: string;
  /** The context path the caller supplied, checked against the deny-list. Absent for runner-built text. */
  path?: string;
  text: string;
}

export interface OutboundLimits {
  max_bytes?: number;
  deny?: string[];
}

export interface OutboundRefusal {
  kind: "deny-listed" | "too-large" | "secret";
  label: string;
  detail: string;
}

function segmentPattern(entry: string): RegExp {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function deniedSegment(path: string, extra: readonly string[]): string | null {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const name = basename(path);
  for (const entry of [...BUILT_IN_DENY, ...extra]) {
    const pattern = segmentPattern(entry);
    if (pattern.test(name) || segments.some((segment) => pattern.test(segment))) return entry;
  }
  return null;
}

/**
 * The deny-list entry a path matches, or null. A path that exists is also
 * checked as it resolves, so a link with an innocent name to a denied file
 * is refused like the file.
 */
export function deniedBy(path: string, extra: readonly string[] = []): string | null {
  const given = deniedSegment(path, extra);
  if (given !== null) return given;
  try {
    return deniedSegment(realpathSync(path), extra);
  } catch {
    return null;
  }
}

/**
 * Every reason the items may not leave the host. An empty list means they may.
 * `sent` is the exact text a seat receives, when it wraps the items; the size
 * cap counts it rather than the items alone.
 */
export function checkOutbound(
  items: readonly OutboundItem[],
  limits: OutboundLimits = {},
  sent?: string,
): OutboundRefusal[] {
  const refusals: OutboundRefusal[] = [];
  for (const item of items) {
    if (item.path !== undefined) {
      const entry = deniedBy(item.path, limits.deny ?? []);
      if (entry !== null)
        refusals.push({ kind: "deny-listed", label: item.label, detail: `path matches deny-list entry ${entry}` });
    }
    const found = scrubSecrets(item.text).found;
    const kinds = REFUSING_KINDS.filter((kind) => (found[kind] ?? 0) > 0);
    if (kinds.length > 0)
      refusals.push({ kind: "secret", label: item.label, detail: `detected credential kinds: ${kinds.join(", ")}` });
  }
  const cap = limits.max_bytes ?? DEFAULT_MAX_BYTES;
  const bytes =
    sent === undefined
      ? items.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0)
      : Buffer.byteLength(sent, "utf8");
  if (bytes > cap)
    refusals.push({ kind: "too-large", label: "payload", detail: `payload is ${bytes} bytes; the cap is ${cap}` });
  return refusals;
}

/** The gate's limits from a council configuration's `limits` and `deny`. */
export function outboundLimits(config: { limits?: { max_bytes?: number }; deny?: string[] }): OutboundLimits {
  const limits: OutboundLimits = {};
  if (config.limits?.max_bytes !== undefined) limits.max_bytes = config.limits.max_bytes;
  if (config.deny !== undefined) limits.deny = config.deny;
  return limits;
}

/** One line per refusal, for an escalation or a record. */
export function describeRefusals(refusals: readonly OutboundRefusal[]): string[] {
  return refusals.map((refusal) => `outbound ${refusal.kind}: ${refusal.label}: ${refusal.detail}`);
}
