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

/** The payload cap: 256 KiB. */
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

export interface OutboundRefusal {
  kind: "deny-listed" | "too-large" | "secret";
  label: string;
  detail: string;
}

function segmentPattern(entry: string): RegExp {
  const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function deniedSegment(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const name = basename(path);
  for (const entry of BUILT_IN_DENY) {
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
export function deniedBy(path: string): string | null {
  const given = deniedSegment(path);
  if (given !== null) return given;
  try {
    return deniedSegment(realpathSync(path));
  } catch {
    return null;
  }
}

const JSON_ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
const JSON_ESCAPED = new Map([
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** Text with its JSON escapes decoded, at every depth of encoding, because an escape hides a token's boundaries. */
function jsonDecoded(text: string): string {
  const once = text.replace(JSON_ESCAPE, (_, hex: string | undefined, char: string) =>
    hex === undefined ? (JSON_ESCAPED.get(char) ?? char) : String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return once === text ? text : jsonDecoded(once);
}

/**
 * Every reason the items may not leave the host. An empty list means they may.
 * Each item's text is scanned as given and JSON-decoded. `sent` is the exact
 * text a seat receives, when it wraps the items; the size cap counts it rather
 * than the items alone.
 */
export function checkOutbound(items: readonly OutboundItem[], sent?: string): OutboundRefusal[] {
  const refusals: OutboundRefusal[] = [];
  for (const item of items) {
    if (item.path !== undefined) {
      const entry = deniedBy(item.path);
      if (entry !== null)
        refusals.push({ kind: "deny-listed", label: item.label, detail: `path matches deny-list entry ${entry}` });
    }
    const raw = scrubSecrets(item.text).found;
    const decoded = scrubSecrets(jsonDecoded(item.text)).found;
    const kinds = REFUSING_KINDS.filter((kind) => (raw[kind] ?? 0) + (decoded[kind] ?? 0) > 0);
    if (kinds.length > 0)
      refusals.push({ kind: "secret", label: item.label, detail: `detected credential kinds: ${kinds.join(", ")}` });
  }
  const bytes =
    sent === undefined
      ? items.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0)
      : Buffer.byteLength(sent, "utf8");
  if (bytes > DEFAULT_MAX_BYTES)
    refusals.push({
      kind: "too-large",
      label: "payload",
      detail: `payload is ${bytes} bytes; the cap is ${DEFAULT_MAX_BYTES}`,
    });
  return refusals;
}

/** One line per refusal, for an escalation or a record. */
export function describeRefusals(refusals: readonly OutboundRefusal[]): string[] {
  return refusals.map((refusal) => `outbound ${refusal.kind}: ${refusal.label}: ${refusal.detail}`);
}
