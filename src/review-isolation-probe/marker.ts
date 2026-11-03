import { randomBytes } from "node:crypto";

const PREFIX = "MARKER_";
const HEX = 32;

/** Fresh `MARKER_` plus 32 lowercase hex digits, one per arm. */
export function newMarker(): string {
  return `${PREFIX}${randomBytes(HEX / 2).toString("hex")}`;
}

export function isMarker(value: string): boolean {
  if (value.length !== PREFIX.length + HEX) return false;
  if (!value.startsWith(PREFIX)) return false;
  for (let i = PREFIX.length; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const hex = code >= 97 && code <= 102;
    if (!digit && !hex) return false;
  }
  return true;
}
