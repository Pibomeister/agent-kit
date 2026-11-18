/**
 * Write a frozen run record without importing the lifecycle CLI.
 * `gate.ts` is `bin/ak-gate.mjs`. Inlining it into `bin/ak` makes `invokedDirectly()` true.
 *
 * One writer per run directory. Overlapping writers are out of scope.
 * Success means both files held this call's bytes at the final readFileSync checks.
 * After each write, the file is read back. A mismatch throws and names the path.
 * A throw removes staging files this call attempted to write when they are regular
 * files, and destination files this call renamed whose bytes are still this call's.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

const isEnoent = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT";

const removeRegularFile = (path: string): void => {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (!st.isFile()) return;
  unlinkSync(path);
};

const ignoreCleanupFailure = (cleanup: () => void): void => {
  try {
    cleanup();
  } catch {
    return;
  }
};

const stillOurBytes = (path: string, expected: Uint8Array): boolean => {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  if (!st.isFile()) return false;
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
  const skipTicket =
    lstatSync(ticketPath, { throwIfNoEntry: false })?.isFile() === true && sha256(readFileSync(ticketPath)) === hash;
  let usedJsonStaging = false;
  let usedTicketStaging = false;
  let wroteJson = false;
  let wroteTicket = false;
  try {
    mkdirSync(dirname(jsonPath), { recursive: true });
    usedJsonStaging = true;
    writeFileSync(jsonStaging, jsonBytes);
    renameSync(jsonStaging, jsonPath);
    wroteJson = true;
    confirmBytes(jsonPath, jsonBytes, toBytes(read(jsonPath)));
    if (!skipTicket) {
      mkdirSync(dirname(ticketPath), { recursive: true });
      usedTicketStaging = true;
      writeFileSync(ticketStaging, ticketBytes);
      renameSync(ticketStaging, ticketPath);
      wroteTicket = true;
      confirmBytes(ticketPath, ticketBytes, toBytes(read(ticketPath)));
    }
    const observedJson = new Uint8Array(readFileSync(jsonPath));
    if (!sameBytes(observedJson, jsonBytes)) throw new Error(`lifecycle persist: read-back mismatch: ${jsonPath}`);
    const observedTicket = new Uint8Array(readFileSync(ticketPath));
    if (!sameBytes(observedTicket, ticketBytes))
      throw new Error(`lifecycle persist: read-back mismatch: ${ticketPath}`);
  } catch (error) {
    ignoreCleanupFailure(() => {
      if (usedJsonStaging) removeRegularFile(jsonStaging);
    });
    ignoreCleanupFailure(() => {
      if (usedTicketStaging) removeRegularFile(ticketStaging);
    });
    ignoreCleanupFailure(() => {
      if (wroteTicket && stillOurBytes(ticketPath, ticketBytes)) removeRegularFile(ticketPath);
    });
    ignoreCleanupFailure(() => {
      if (wroteJson && stillOurBytes(jsonPath, jsonBytes)) removeRegularFile(jsonPath);
    });
    throw error;
  }
}
