/**
 * persistFrozenRun read-after-write: refuse when the bytes on disk are not what was written.
 * A throw removes only what this call wrote, including pid staging files that are regular files.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const persistModule = join(import.meta.dir, "../../src/lifecycle/persist-run.ts");

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

function ticketPath(dir: string, runId: string, hash = ticketHash): string {
  return join(dir, runId, "artifacts", hash.slice("sha256:".length));
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function plantFile(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function leftoverPartial(root: string, pid: number): string[] {
  const needle = `.partial-${pid}`;
  const found: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.name.includes(needle)) found.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return found;
}

function persistUnderFileSizeLimit(dir: string, record: FrozenRunRecord, bytes: Uint8Array): number {
  const script = join(dir, "child.mjs");
  const pidPath = join(dir, "child.pid");
  const recordPath = join(dir, "record.json");
  const ticketBin = join(dir, "ticket.bin");
  const evidence = join(dir, "evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(ticketBin, bytes);
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
import { persistFrozenRun } from ${JSON.stringify(persistModule)};
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const record = JSON.parse(readFileSync(${JSON.stringify(recordPath)}, "utf8"));
const ticketBytes = new Uint8Array(readFileSync(${JSON.stringify(ticketBin)}));
try {
  persistFrozenRun(${JSON.stringify(evidence)}, record, ticketBytes);
} catch {
  writeFileSync(${JSON.stringify(join(dir, "child.err"))}, "threw");
}
`,
  );
  const child = spawnSync("bash", ["-c", `ulimit -f 1; exec "$1" "$2"`, "--", process.execPath, script], {
    encoding: "utf8",
  });
  if (!existsSync(pidPath)) {
    throw new Error(`file-size child wrote no pid: exit ${child.status}\n${child.stderr}\n${child.stdout}`);
  }
  return Number(readFileSync(pidPath, "utf8"));
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
    expect(lstatSync(`${json}.partial-${process.pid}`).isDirectory()).toBe(true);
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

  test("json staging is removed when rename onto a directory fails", () => {
    const dir = processScratch("ak-persist-staging-json-");
    const runId = "run-staging-json";
    const json = jsonPath(dir, runId);
    mkdirSync(json, { recursive: true });
    writeFileSync(join(json, "sentinel"), "keep\n");
    expect(() => persistFrozenRun(dir, recordFor(runId), ticketBytes)).toThrow();
    expect(existsSync(`${json}.partial-${process.pid}`)).toBe(false);
    expect(lstatSync(json).isDirectory()).toBe(true);
    expect(readFileSync(join(json, "sentinel"), "utf8")).toBe("keep\n");
  });

  test("ticket staging is removed when rename onto a directory fails", () => {
    const dir = processScratch("ak-persist-staging-ticket-");
    const runId = "run-staging-ticket";
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    mkdirSync(ticketFile, { recursive: true });
    writeFileSync(join(ticketFile, "sentinel"), "keep\n");
    expect(() => persistFrozenRun(dir, recordFor(runId), ticketBytes)).toThrow();
    expect(existsSync(`${ticketFile}.partial-${process.pid}`)).toBe(false);
    expect(lstatSync(ticketFile).isDirectory()).toBe(true);
    expect(readFileSync(join(ticketFile, "sentinel"), "utf8")).toBe("keep\n");
    expect(existsSync(json)).toBe(false);
  });

  test("a writeFileSync that creates json staging then throws leaves no pid staging file", () => {
    const dir = processScratch("ak-persist-efbig-json-");
    const runId = "run-efbig-json";
    const record = recordFor(runId);
    record.behavior = "n".repeat(2048);
    const pid = persistUnderFileSizeLimit(dir, record, ticketBytes);
    expect(existsSync(join(dir, "child.err"))).toBe(true);
    expect(leftoverPartial(dir, pid)).toEqual([]);
  });

  test("a writeFileSync that creates ticket staging then throws leaves no pid staging file", () => {
    const dir = processScratch("ak-persist-efbig-ticket-");
    const runId = "run-efbig-ticket";
    const largeTicket = new Uint8Array(2048).fill(7);
    const hash = sha256(largeTicket);
    const pid = persistUnderFileSizeLimit(dir, recordFor(runId, hash), largeTicket);
    expect(existsSync(join(dir, "child.err"))).toBe(true);
    expect(leftoverPartial(dir, pid)).toEqual([]);
  });

  test("compact parse-equal JSON written after confirm is left in place", () => {
    const dir = processScratch("ak-persist-parse-final-");
    const runId = "run-parse-final";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    const compact = JSON.stringify(record);
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) return jsonBytes;
        if (path === ticketFile) {
          writeFileSync(json, compact);
          return ticketBytes;
        }
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(json);
    expect(readFileSync(json, "utf8")).toBe(compact);
    expect(existsSync(ticketFile)).toBe(false);
  });

  test("foreign ticket bytes on disk after an injected confirm name the ticket path", () => {
    const dir = processScratch("ak-persist-ticket-reread-");
    const runId = "run-ticket-reread";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) return jsonBytes;
        if (path === ticketFile) {
          writeFileSync(ticketFile, plantedTicket);
          return ticketBytes;
        }
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(ticketFile);
    assertNoPersist(dir, runId);
  });

  test("a planted matching ticket mutated during the json read is refused", () => {
    const dir = processScratch("ak-persist-skip-reread-");
    const runId = "run-skip-reread";
    const record = recordFor(runId);
    const json = jsonPath(dir, runId);
    const ticketFile = ticketPath(dir, runId);
    const jsonBytes = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
    plantFile(ticketFile, ticketBytes);
    expect(() =>
      persistFrozenRun(dir, record, ticketBytes, (path) => {
        if (path === json) {
          writeFileSync(ticketFile, plantedTicket);
          return jsonBytes;
        }
        if (path === ticketFile) return ticketBytes;
        return new Uint8Array(readFileSync(path));
      }),
    ).toThrow(ticketFile);
    expect(Buffer.from(readFileSync(ticketFile)).equals(Buffer.from(plantedTicket))).toBe(true);
    expect(existsSync(json)).toBe(false);
  });
});
