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

const atomicJson = (path: string, value: FrozenRunRecord): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
};

const atomicBytes = (path: string, value: Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.partial-${process.pid}`;
  writeFileSync(staging, value);
  renameSync(staging, path);
};

const sha256 = (value: Uint8Array | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function persistFrozenRun(dir: string, record: FrozenRunRecord, ticketBytes: Uint8Array): void {
  atomicJson(join(dir, "runs", safeRunId(record.run_id), "run.json"), record);
  const hash = sha256(ticketBytes);
  const path = join(dir, safeRunId(record.run_id), "artifacts", hash.slice("sha256:".length));
  if (!existsSync(path) || sha256(readFileSync(path)) !== hash) atomicBytes(path, ticketBytes);
}
