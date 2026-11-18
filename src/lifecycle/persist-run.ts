/**
 * Write a frozen run record without importing the lifecycle CLI.
 * `gate.ts` is `bin/ak-gate.mjs`. Inlining it into `bin/ak` makes `invokedDirectly()` true.
 *
 * After each write, the file is read back. A mismatch throws and names the path.
 * Read-back of run.json requires the exact pretty-printed bytes that were written.
 * A throw removes only what this call wrote. Pre-existing run.json or ticket bytes stay.
 * If run.json on disk is no longer this call's bytes, it is left in place.
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

const stagingFor = (path: string): string => `${path}.partial-${process.pid}`;

const sha256 = (value: Uint8Array | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const removeFileIfPresent = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

const stillOurBytes = (path: string, expected: Uint8Array): boolean => {
  if (!existsSync(path)) return false;
  return sameBytes(new Uint8Array(readFileSync(path)), expected);
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
  const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
  const jsonStaging = stagingFor(jsonPath);
  const ticketStaging = stagingFor(ticketPath);
  if (hash !== record.ticket.hash) throw new Error(`lifecycle persist: ticket hash mismatch: ${ticketPath}`);
  const skipTicket = existsSync(ticketPath) && sha256(readFileSync(ticketPath)) === hash;
  let wroteJsonStaging = false;
  let wroteTicketStaging = false;
  let wroteJson = false;
  let wroteTicket = false;
  try {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonStaging, jsonBytes);
    wroteJsonStaging = true;
    renameSync(jsonStaging, jsonPath);
    wroteJson = true;
    confirmBytes(jsonPath, jsonBytes, toBytes(read(jsonPath)));
    if (!skipTicket) {
      mkdirSync(dirname(ticketPath), { recursive: true });
      writeFileSync(ticketStaging, ticketBytes);
      wroteTicketStaging = true;
      renameSync(ticketStaging, ticketPath);
      wroteTicket = true;
      confirmBytes(ticketPath, ticketBytes, toBytes(read(ticketPath)));
    }
    const observedTicket = toBytes(read(ticketPath));
    if (!sameBytes(observedTicket, ticketBytes) || sha256(observedTicket) !== record.ticket.hash)
      throw new Error(`lifecycle persist: read-back mismatch: ${ticketPath}`);
    const observedJson = new Uint8Array(readFileSync(jsonPath));
    if (!sameBytes(observedJson, jsonBytes)) throw new Error(`lifecycle persist: read-back mismatch: ${jsonPath}`);
  } catch (error) {
    if (wroteJsonStaging && !wroteJson) removeFileIfPresent(jsonStaging);
    if (wroteTicketStaging && !wroteTicket) removeFileIfPresent(ticketStaging);
    if (wroteTicket) removeFileIfPresent(ticketPath);
    if (wroteJson && stillOurBytes(jsonPath, jsonBytes)) removeFileIfPresent(jsonPath);
    throw error;
  }
}
