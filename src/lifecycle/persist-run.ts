/**
 * Write a frozen run record without importing the lifecycle CLI.
 * `gate.ts` is `bin/ak-gate.mjs`. Inlining it into `bin/ak` makes `invokedDirectly()` true.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FrozenRunRecord {
  run_id: string;
  ticket: { id: string; hash: string };
  opened_at: string;
  branch: string;
  base: string;
  schema_version?: number;
  behavior?: unknown;
}

const safeRunId = (id: string): string => id.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);

const toBytes = (value: Uint8Array): Uint8Array => new Uint8Array(value);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));

const confirmJson = (path: string, value: FrozenRunRecord, expected: string, observed: Uint8Array): void => {
  if (sameBytes(observed, new TextEncoder().encode(expected))) return;
  let jsonMatch = false;
  try {
    jsonMatch = JSON.stringify(JSON.parse(new TextDecoder().decode(observed))) === JSON.stringify(value);
  } catch {
    jsonMatch = false;
  }
  if (!jsonMatch) throw new Error(`lifecycle persist: read-back mismatch: ${path}`);
};

const atomicJson = (path: string, value: FrozenRunRecord, read: (path: string) => Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(staging, expected);
  renameSync(staging, path);
  confirmJson(path, value, expected, toBytes(read(path)));
};

const atomicBytes = (path: string, value: Uint8Array, read: (path: string) => Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, value);
  renameSync(staging, path);
  const observed = toBytes(read(path));
  if (!sameBytes(observed, value)) throw new Error(`lifecycle persist: read-back mismatch: ${path}`);
};

const sha256 = (value: Uint8Array | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function persistFrozenRun(
  dir: string,
  record: FrozenRunRecord,
  ticketBytes: Uint8Array,
  read: (path: string) => Uint8Array = (path) => new Uint8Array(readFileSync(path)),
): void {
  const hash = sha256(ticketBytes);
  const ticketPath = join(dir, safeRunId(record.run_id), "artifacts", hash.slice("sha256:".length));
  if (hash !== record.ticket.hash) throw new Error(`lifecycle persist: ticket hash mismatch: ${ticketPath}`);
  atomicJson(join(dir, "runs", safeRunId(record.run_id), "run.json"), record, read);
  if (!existsSync(ticketPath) || sha256(readFileSync(ticketPath)) !== hash) atomicBytes(ticketPath, ticketBytes, read);
  const observed = toBytes(read(ticketPath));
  if (!sameBytes(observed, ticketBytes) || sha256(observed) !== record.ticket.hash)
    throw new Error(`lifecycle persist: read-back mismatch: ${ticketPath}`);
}
