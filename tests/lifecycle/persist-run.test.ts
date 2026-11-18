/**
 * persistFrozenRun read-after-write: refuse when the bytes on disk are not what was written.
 * A throw removes only what this call wrote.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { persistFrozenRun, type FrozenRunRecord } from "../../src/lifecycle/persist-run.ts";
import { artifactHash, canonicalJson } from "../../src/util/hash.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const ticket = { schema: "ticket", id: "T-readback", title: "persist" };
const ticketBytes = new TextEncoder().encode(
  canonicalJson(Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "approvals"))),
);
const ticketHash = artifactHash(ticket);
const plantedJson = "planted-run-json\n";
const plantedTicket = new Uint8Array([9, 9, 9]);
const foreignJson = "foreign-run-json\n";

function recordFor(runId: string, hash = ticketHash): FrozenRunRecord {
  return {
    run_id: runId,
    ticket: { id: "T-readback", hash },
    opened_at: "2026-09-29T00:00:00Z",
    branch: "feature",
    base: "main",
  };
}

function jsonPath(dir: string, runId: string): string {
  return join(dir, "runs", runId, "run.json");
}

function ticketPath(dir: string, runId: string): string {
  return join(dir, runId, "artifacts", ticketHash.slice("sha256:".length));
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function plantFile(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function assertNoPersist(dir: string, runId: string): void {
  expect(existsSync(jsonPath(dir, runId))).toBe(false);
  expect(existsSync(ticketPath(dir, runId))).toBe(false);
}

describe("persistFrozenRun", () => {
  test("an injected read that returns different bytes throws and leaves no success result", () => {
    const dir = processScratch("ak-persist-readback-");
    const runId = "run-mismatch";
    const record = recordFor(runId);
    let succeeded = false;
    try {
      persistFrozenRun(dir, record, ticketBytes, () => new Uint8Array([1, 2, 3]));
      succeeded = true;
    } catch (error) {
      expect(String(error)).toContain(jsonPath(dir, runId));
    }
    expect(succeeded).toBe(false);
    assertNoPersist(dir, runId);
  });

  test("a planted run.json survives a ticket-hash mismatch and no ticket is created", () => {
    const dir = processScratch("ak-persist-t1-");
    const runId = "run-t1";
    const json = jsonPath(dir, runId);
    plantFile(json, plantedJson);
    const record = recordFor(runId, `sha256:${"0".repeat(64)}`);
    expect(() => persistFrozenRun(dir, record, ticketBytes)).toThrow(ticketPath(dir, runId));
    expect(readFileSync(json, "utf8")).toBe(plantedJson);
    expect(existsSync(ticketPath(dir, runId))).toBe(false);
  });

  test("a planted run.json survives when json staging is a directory", () => {
    const dir = processScratch("ak-persist-c1-");
    const runId = "run-c1";
    const json = jsonPath(dir, runId);
    plantFile(json, plantedJson);
    mkdirSync(`${json}.partial-${process.pid}`);
    expect(() => persistFrozenRun(dir, recordFor(runId), ticketBytes)).toThrow();
    expect(readFileSync(json, "utf8")).toBe(plantedJson);
  });

  test("a planted unmatched ticket survives a failed json confirm", () => {
    const dir = processScratch("ak-persist-t2-");
    const runId = "run-t2";
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    plantFile(ticketFile, plantedTicket);
    expect(() =>
      persistFrozenRun(dir, recordFor(runId), ticketBytes, (path) => {
        if (path === json) return new Uint8Array([1, 2, 3]);
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(json);
    expect(Buffer.from(readFileSync(ticketFile)).equals(Buffer.from(plantedTicket))).toBe(true);
    expect(existsSync(json)).toBe(false);
  });

  test("a planted matching ticket survives a failed json confirm and this call's run.json is gone", () => {
    const dir = processScratch("ak-persist-t4-");
    const runId = "run-t4";
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    plantFile(ticketFile, ticketBytes);
    expect(() =>
      persistFrozenRun(dir, recordFor(runId), ticketBytes, (path) => {
        if (path === json) return new Uint8Array([1, 2, 3]);
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(json);
    expect(Buffer.from(readFileSync(ticketFile)).equals(Buffer.from(ticketBytes))).toBe(true);
    expect(existsSync(json)).toBe(false);
  });

  test("compact JSON that parses equal is still a run.json read-back mismatch", () => {
    const dir = processScratch("ak-persist-t3-");
    const runId = "run-t3";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const compact = new TextEncoder().encode(JSON.stringify(record));
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) return compact;
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(json);
    assertNoPersist(dir, runId);
  });

  test("foreign run.json bytes after confirm are left in place", () => {
    const dir = processScratch("ak-persist-adv3-");
    const runId = "run-adv3";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) return jsonBytes;
        if (path === ticketFile) {
          writeFileSync(json, foreignJson);
          return ticketBytes;
        }
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(json);
    expect(readFileSync(json, "utf8")).toBe(foreignJson);
    expect(existsSync(ticketFile)).toBe(false);
  });

  test("a matching read-back leaves the same run.json and ticket bytes on disk", () => {
    const dir = processScratch("ak-persist-match-");
    const runId = "run-match";
    const record = recordFor(runId);
    persistFrozenRun(dir, record, ticketBytes);
    const expectedJson = `${JSON.stringify(record, null, 2)}\n`;
    expect(readFileSync(jsonPath(dir, runId), "utf8")).toBe(expectedJson);
    const onDiskTicket = new Uint8Array(readFileSync(ticketPath(dir, runId)));
    expect(Buffer.from(onDiskTicket).equals(Buffer.from(ticketBytes))).toBe(true);
    expect(sha256(onDiskTicket)).toBe(record.ticket.hash);
  });

  test("ENOTDIR while creating the ticket directory leaves no run.json", () => {
    const dir = processScratch("ak-persist-enotdir-");
    const runId = "run-enotdir";
    writeFileSync(join(dir, runId), "not a directory\n");
    expect(() => persistFrozenRun(dir, recordFor(runId), ticketBytes)).toThrow();
    expect(existsSync(jsonPath(dir, runId))).toBe(false);
  });

  test("a path-aware injected read that lies about the ticket names the ticket path", () => {
    const dir = processScratch("ak-persist-ticket-read-");
    const runId = "run-ticket-read";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) return jsonBytes;
        if (path === ticketFile) return new Uint8Array([1, 2, 3]);
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(ticketFile);
    assertNoPersist(dir, runId);
  });
});
