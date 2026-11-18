/**
 * persistFrozenRun read-after-write: refuse when the bytes on disk are not what was written.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonObject } from "../../src/lifecycle/behavior-policy.ts";
import { persistFrozenRun, type FrozenRunRecord } from "../../src/lifecycle/persist-run.ts";
import { artifactHash, canonicalJson } from "../../src/util/hash.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const ticket = { schema: "ticket", id: "T-readback", title: "persist" };
const ticketBytes = new TextEncoder().encode(
  canonicalJson(Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "approvals"))),
);

function recordFor(runId: string, hash = artifactHash(ticket)): FrozenRunRecord {
  return {
    run_id: runId,
    ticket: { id: "T-readback", hash },
    opened_at: "2026-09-29T00:00:00Z",
    branch: "feature",
    base: "main",
  };
}

describe("persistFrozenRun", () => {
  test("an injected read that returns different bytes throws and leaves no success result", () => {
    const dir = processScratch("ak-persist-readback-");
    const record = recordFor("run-mismatch");
    const jsonPath = join(dir, "runs", "run-mismatch", "run.json");
    let succeeded = false;
    try {
      persistFrozenRun(dir, record, ticketBytes, () => new Uint8Array([1, 2, 3]));
      succeeded = true;
    } catch (error) {
      expect(String(error)).toContain(jsonPath);
    }
    expect(succeeded).toBe(false);
  });

  test("a ticket artifact whose on-disk hash is not record.ticket.hash is refused", () => {
    const dir = processScratch("ak-persist-ticket-hash-");
    const record = recordFor("run-ticket-hash", `sha256:${"0".repeat(64)}`);
    const jsonPath = join(dir, "runs", "run-ticket-hash", "run.json");
    const ticketPath = join(dir, "run-ticket-hash", "artifacts", artifactHash(ticket).slice("sha256:".length));
    expect(() => persistFrozenRun(dir, record, ticketBytes)).toThrow(ticketPath);
    expect(existsSync(jsonPath)).toBe(false);
  });

  test("a matching read-back leaves the same run.json that the current tests parse", () => {
    const dir = processScratch("ak-persist-match-");
    const record = recordFor("run-match");
    persistFrozenRun(dir, record, ticketBytes);
    const jsonPath = join(dir, "runs", "run-match", "run.json");
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (!asJsonObject(parsed)) throw new Error("run.json is not an object");
    expect(parsed.run_id).toBe(record.run_id);
    expect(parsed.opened_at).toBe(record.opened_at);
    expect(parsed.branch).toBe(record.branch);
    expect(parsed.base).toBe(record.base);
    expect(asJsonObject(parsed.ticket) ? parsed.ticket : undefined).toEqual(record.ticket);
  });
});
