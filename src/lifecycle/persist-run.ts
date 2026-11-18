/**
 * Write a frozen run record without importing the lifecycle CLI.
 * `gate.ts` is `bin/ak-gate.mjs`. Inlining it into `bin/ak` makes `invokedDirectly()` true.
 *
 * After each write, the file is read back. A mismatch throws and names the path.
 * Read-back of run.json requires the exact pretty-printed bytes that were written.
 * A throw leaves no run.json. A ticket this call wrote is removed with it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

const confirmBytes = (path: string, expected: Uint8Array, observed: Uint8Array): void => {
  if (!sameBytes(observed, expected)) throw new Error(`lifecycle persist: read-back mismatch: ${path}`);
};

const atomicWrite = (path: string, value: Uint8Array, read: (path: string) => Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, value);
  renameSync(staging, path);
  confirmBytes(path, value, toBytes(read(path)));
};

const sha256 = (value: Uint8Array | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const removeIfPresent = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

export function persistFrozenRun(
  dir: string,
  record: FrozenRunRecord,
  ticketBytes: Uint8Array,
  read: (path: string) => Uint8Array = (path) => new Uint8Array(readFileSync(path)),
): void {
  const hash = sha256(ticketBytes);
  const ticketPath = join(dir, safeRunId(record.run_id), "artifacts", hash.slice("sha256:".length));
  const jsonPath = join(dir, "runs", safeRunId(record.run_id), "run.json");
  if (hash !== record.ticket.hash) throw new Error(`lifecycle persist: ticket hash mismatch: ${ticketPath}`);
  const ticketExisted = existsSync(ticketPath) && sha256(readFileSync(ticketPath)) === hash;
  try {
    atomicWrite(jsonPath, new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`), read);
    if (!ticketExisted) atomicWrite(ticketPath, ticketBytes, read);
    const observed = toBytes(read(ticketPath));
    if (!sameBytes(observed, ticketBytes) || sha256(observed) !== record.ticket.hash)
      throw new Error(`lifecycle persist: read-back mismatch: ${ticketPath}`);
  } catch (error) {
    removeIfPresent(jsonPath);
    if (!ticketExisted) removeIfPresent(ticketPath);
    throw error;
  }
}
