/**
 * One check per normalized input. Each attempt owns one generation file under
 * `<receipts>/claims/<key>/`, created exclusively; settlement replaces only the owner's record.
 * Claims are unsigned advisory state owned by the user that owns the receipts directory.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { parseTraceparent } from "../learn/core/trace.ts";
import pin from "../../provenance/semantic-lint.json";

export const CLAIM_VERSION = 1;
export const STALE_MS = 120_000;

export interface Claim {
  path: string;
  generation: number;
}
export type Acquired =
  | { kind: "owner"; claim: Claim }
  | { kind: "duplicate"; trace: string | null }
  | { kind: "in-progress" }
  | { kind: "error" };

type State = "in-progress" | "complete" | "released";
interface ClaimRecord {
  state: State;
  trace: string;
  started_at: number;
  ended_at: number | null;
}

const ajv = new Ajv({ strict: false });
const isRecord = ajv.compile<ClaimRecord>({
  type: "object",
  required: ["state", "trace", "started_at", "ended_at"],
  properties: {
    state: { enum: ["in-progress", "complete", "released"] },
    trace: { type: "string" },
    started_at: { type: "number" },
    ended_at: { type: ["number", "null"] },
  },
});
const GENERATION = /^[1-9][0-9]*$/;

/** `body` is the exact request string the batch sends: questions, files and model. */
export function claimKey(body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([CLAIM_VERSION, pin.revision, pin.endpoint, body]))
    .digest("hex");
}

function line(record: ClaimRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function taken(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EEXIST";
}

/** Unparsable or empty content is an attempt still writing its first record. */
function current(path: string): ClaimRecord {
  const text = readFileSync(path, "utf8");
  try {
    const raw: unknown = JSON.parse(text);
    if (isRecord(raw)) return raw;
  } catch {
    // Falls through to the in-progress reading below.
  }
  return { state: "in-progress", trace: "", started_at: statSync(path).mtimeMs, ended_at: null };
}

export function acquireClaim(receipts: string, key: string, trace: string, now: () => number = Date.now): Acquired {
  const dir = join(receipts, "claims", key);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { kind: "error" };
  }
  for (let round = 0; round < 3; round += 1) {
    let next = 1;
    try {
      const highest = Math.max(
        0,
        ...readdirSync(dir)
          .filter((name) => GENERATION.test(name))
          .map(Number),
      );
      if (highest > 0) {
        const record = current(join(dir, String(highest)));
        if (record.state === "complete")
          return { kind: "duplicate", trace: parseTraceparent(record.trace) === null ? null : record.trace };
        if (record.state === "in-progress" && now() - record.started_at < STALE_MS) return { kind: "in-progress" };
        next = highest + 1;
      }
    } catch {
      return { kind: "error" };
    }
    const path = join(dir, String(next));
    try {
      writeFileSync(path, line({ state: "in-progress", trace, started_at: now(), ended_at: null }), {
        flag: "wx",
        mode: 0o600,
      });
      return { kind: "owner", claim: { path, generation: next } };
    } catch (cause) {
      if (!taken(cause)) return { kind: "error" };
    }
  }
  return { kind: "in-progress" };
}

/** Only the owner of a generation settles it. Never throws. */
export function settleClaim(
  claim: Claim,
  state: "complete" | "released",
  trace: string,
  now: () => number = Date.now,
): boolean {
  try {
    const { started_at } = current(claim.path);
    const temp = `${claim.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temp, line({ state, trace, started_at, ended_at: now() }), { flag: "wx", mode: 0o600 });
    renameSync(temp, claim.path);
    return true;
  } catch {
    return false;
  }
}
