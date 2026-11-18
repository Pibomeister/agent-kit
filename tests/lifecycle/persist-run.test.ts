/**
 * persistFrozenRun read-after-write: refuse when the bytes on disk are not what was written.
 * A throw leaves no run.json and no ticket this call wrote.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { persistFrozenRun, type FrozenRunRecord } from "../../src/lifecycle/persist-run.ts";
import { artifactHash, canonicalJson } from "../../src/util/hash.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const ticket = { schema: "ticket", id: "T-readback", title: "persist" };
const ticketBytes = new TextEncoder().encode(
  canonicalJson(Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "approvals"))),
);
const ticketHash = artifactHash(ticket);

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

  test("a ticket artifact whose on-disk hash is not record.ticket.hash is refused", () => {
    const dir = processScratch("ak-persist-ticket-hash-");
    const runId = "run-ticket-hash";
    const record = recordFor(runId, `sha256:${"0".repeat(64)}`);
    expect(() => persistFrozenRun(dir, record, ticketBytes)).toThrow(ticketPath(dir, runId));
    assertNoPersist(dir, runId);
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
    assertNoPersist(dir, runId);
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

  test("a second ticket read that does not match is refused", () => {
    const dir = processScratch("ak-persist-ticket-second-");
    const runId = "run-ticket-second";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    let ticketReads = 0;
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) return jsonBytes;
        if (path === ticketFile) {
          ticketReads += 1;
          if (ticketReads === 1) return ticketBytes;
          return new Uint8Array([1, 2, 3]);
        }
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(ticketFile);
    assertNoPersist(dir, runId);
  });
});
