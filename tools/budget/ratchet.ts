/**
 * The token-budget ratchet: the size of every fixed text agent-kit hands an agent (`surfaces.ts`) is
 * pinned in `tools/budget/baseline.json`, in bytes and in estimated tokens. A run fails when a
 * surface is larger than its pin, and when it is smaller, because a pin left above the text is room
 * the next change could spend without anyone seeing it. A surface nobody pinned fails too, and so
 * does a pin for a surface that is no longer emitted. `--update` writes the measured sizes, and
 * refuses growth unless `--allow-growth` says the increase is intended, so the baseline diff is
 * where a reviewer sees it.
 *
 *   bun tools/budget/ratchet.ts [--root <dir>] [--update [--allow-growth]]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020, { type JSONSchemaType } from "ajv/dist/2020.js";

import { estimateTokens } from "../../src/validation/skill-style.ts";
import { collectSurfaces, type Surface } from "./surfaces.ts";

export const BASELINE = "tools/budget/baseline.json";

/** Recorded in the baseline, so a change of estimator is a re-pin rather than a silent shift of every count. */
export const ESTIMATOR =
  "chars/4 rounded up: ceil(UTF-16 code units / 4), estimateTokens in src/validation/skill-style.ts";

export interface Size {
  file: string;
  bytes: number;
  tokens: number;
}

export interface Baseline {
  estimator: string;
  surfaces: Record<string, Size>;
}

export type Change =
  | { kind: "grew" | "shrank"; id: string; pinned: Size; actual: Size }
  | { kind: "unpinned"; id: string; actual: Size }
  | { kind: "gone"; id: string; pinned: Size };

export interface RatchetResult {
  /** True when the baseline was measured with a different estimator; every token count is then incomparable. */
  estimatorChanged: boolean;
  changes: Change[];
  actual: Baseline;
}

const SIZE_SCHEMA: JSONSchemaType<Size> = {
  type: "object",
  required: ["file", "bytes", "tokens"],
  additionalProperties: false,
  properties: {
    file: { type: "string" },
    bytes: { type: "integer", minimum: 0 },
    tokens: { type: "integer", minimum: 0 },
  },
};

const BASELINE_SCHEMA: JSONSchemaType<Baseline> = {
  type: "object",
  required: ["estimator", "surfaces"],
  additionalProperties: false,
  properties: {
    estimator: { type: "string" },
    surfaces: { type: "object", required: [], additionalProperties: SIZE_SCHEMA },
  },
};

const validateBaseline = new Ajv2020({ strict: false, allErrors: true }).compile(BASELINE_SCHEMA);

export function measure(surface: Surface): Size {
  return { file: surface.file, bytes: Buffer.byteLength(surface.text, "utf8"), tokens: estimateTokens(surface.text) };
}

/** Parse baseline text through the schema; `source` names where it came from in the error. */
export function parseBaseline(text: string, source: string = BASELINE): Baseline {
  const parsed: unknown = JSON.parse(text);
  if (!validateBaseline(parsed)) {
    const detail = (validateBaseline.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
    throw new Error(`${source} is malformed: ${detail.join("; ")}`);
  }
  return parsed;
}

export function readBaseline(root: string): Baseline {
  const file = join(root, BASELINE);
  if (!existsSync(file)) return { estimator: ESTIMATOR, surfaces: {} };
  return parseBaseline(readFileSync(file, "utf8"));
}

/** Code-unit order, so the baseline's key order never depends on the machine's locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function serialize(baseline: Baseline): string {
  const surfaces = Object.fromEntries(Object.entries(baseline.surfaces).toSorted(([a], [b]) => byCodeUnit(a, b)));
  return `${JSON.stringify({ estimator: baseline.estimator, surfaces }, null, 2)}\n`;
}

export function compare(baseline: Baseline, surfaces: readonly Surface[]): RatchetResult {
  const actual: Baseline = { estimator: ESTIMATOR, surfaces: {} };
  for (const surface of surfaces) {
    if (actual.surfaces[surface.id] !== undefined) throw new Error(`two surfaces share the id ${surface.id}`);
    actual.surfaces[surface.id] = measure(surface);
  }
  const changes: Change[] = [];
  for (const [id, size] of Object.entries(actual.surfaces)) {
    const pinned = baseline.surfaces[id];
    if (pinned === undefined) changes.push({ kind: "unpinned", id, actual: size });
    else if (size.bytes > pinned.bytes || size.tokens > pinned.tokens)
      changes.push({ kind: "grew", id, pinned, actual: size });
    else if (size.bytes < pinned.bytes || size.tokens < pinned.tokens)
      changes.push({ kind: "shrank", id, pinned, actual: size });
  }
  for (const [id, pinned] of Object.entries(baseline.surfaces)) {
    if (actual.surfaces[id] === undefined) changes.push({ kind: "gone", id, pinned });
  }
  changes.sort((a, b) => byCodeUnit(a.id, b.id));
  return { estimatorChanged: baseline.estimator !== ESTIMATOR, changes, actual };
}

/** Growth is what `--update` refuses without `--allow-growth`. */
export function isGrowth(change: Change): boolean {
  return change.kind === "grew" || change.kind === "unpinned";
}

/**
 * The baseline `--update` writes, or null when it refuses: growth, an unpinned surface or a change of
 * estimator needs `allowGrowth`, and a shrink or a dropped surface never does.
 */
export function applyUpdate(result: RatchetResult, allowGrowth: boolean): Baseline | null {
  if ((result.estimatorChanged || result.changes.some(isGrowth)) && !allowGrowth) return null;
  return result.actual;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/** One line per change, naming the file to edit, the delta and the command that records it. */
export function describeChange(change: Change): string {
  if (change.kind === "unpinned") {
    const { actual } = change;
    return `${actual.file}: ${change.id} is not pinned (${actual.bytes} bytes, ${actual.tokens} est. tokens). Pin it: bun run budget:baseline -- --allow-growth`;
  }
  if (change.kind === "gone") {
    return `${change.pinned.file}: ${change.id} is pinned at ${change.pinned.bytes} bytes but no longer emitted. Drop the pin: bun run budget:baseline`;
  }
  const { pinned, actual } = change;
  const delta = `${signed(actual.bytes - pinned.bytes)} bytes, ${signed(actual.tokens - pinned.tokens)} est. tokens`;
  const sizes = `${pinned.bytes} -> ${actual.bytes} bytes, ${pinned.tokens} -> ${actual.tokens} est. tokens`;
  return change.kind === "grew"
    ? `${actual.file}: ${change.id} grew ${delta} (${sizes}). Trim it, or raise the pin: bun run budget:baseline -- --allow-growth`
    : `${actual.file}: ${change.id} shrank ${delta} (${sizes}). Lower the pin: bun run budget:baseline`;
}

export function estimatorMessage(baseline: Baseline): string {
  return `${BASELINE} was measured with "${baseline.estimator}", and this tree estimates with "${ESTIMATOR}". Re-pin every surface: bun run budget:baseline -- --allow-growth`;
}

export function main(argv: readonly string[]): number {
  const args = [...argv];
  const take = (flag: string): boolean => {
    const at = args.indexOf(flag);
    if (at >= 0) args.splice(at, 1);
    return at >= 0;
  };
  const rootAt = args.indexOf("--root");
  const root = rootAt >= 0 ? resolve(args.splice(rootAt, 2)[1] ?? ".") : process.cwd();
  const update = take("--update");
  const allowGrowth = take("--allow-growth");
  if (args.length > 0) {
    console.error("usage: ratchet.ts [--root <dir>] [--update [--allow-growth]]");
    return 2;
  }

  const baseline = readBaseline(root);
  const result = compare(baseline, collectSurfaces(root));
  const growth = result.changes.filter(isGrowth);

  if (update) {
    const next = applyUpdate(result, allowGrowth);
    if (next === null) {
      if (result.estimatorChanged) console.error(estimatorMessage(baseline));
      for (const change of growth) console.error(describeChange(change));
      console.error(
        "The baseline does not grow on its own. Trim the text above, or pass --allow-growth so the increase lands in the baseline diff, where review sees it.",
      );
      return 1;
    }
    writeFileSync(join(root, BASELINE), serialize(next));
    const lowered = result.changes.length - growth.length;
    console.log(`${BASELINE} written: ${lowered} pin(s) lowered or dropped, ${growth.length} raised or added.`);
    return 0;
  }

  if (result.estimatorChanged) console.log(estimatorMessage(baseline));
  for (const change of result.changes) console.log(describeChange(change));
  if (result.estimatorChanged || result.changes.length > 0) return 1;
  const sizes = Object.values(result.actual.surfaces);
  const bytes = sizes.reduce((sum, size) => sum + size.bytes, 0);
  const tokens = sizes.reduce((sum, size) => sum + size.tokens, 0);
  console.log(
    `budget: ${sizes.length} surfaces at their pins; ${bytes} bytes, ${tokens} est. tokens in all (${ESTIMATOR}).`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
