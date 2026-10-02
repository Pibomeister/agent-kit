/** Versioned token prices used to estimate Codex session cost. Not a test file. */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { PACKAGE_ROOT } from "../../../src/learn/core/roles.ts";
import type { SessionResult, TokenUsage } from "./subjects/types.ts";

export interface TokenPrice {
  inputPerMillionUsd: number;
  cachedInputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface PriceTable {
  version: number;
  asOf: string;
  models: Record<string, TokenPrice>;
}

interface PriceTableFile {
  version: number;
  as_of: string;
  source: string;
  verified_against_live_session: boolean;
  models: Record<
    string,
    {
      input_per_million_usd: number;
      cached_input_per_million_usd: number;
      output_per_million_usd: number;
    }
  >;
}

const PRICE_TABLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "as_of", "source", "verified_against_live_session", "models"],
  properties: {
    version: { type: "integer", minimum: 1 },
    as_of: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    source: { type: "string", pattern: "^https://" },
    verified_against_live_session: { type: "boolean" },
    models: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["input_per_million_usd", "cached_input_per_million_usd", "output_per_million_usd"],
        properties: {
          input_per_million_usd: { type: "number", minimum: 0 },
          cached_input_per_million_usd: { type: "number", minimum: 0 },
          output_per_million_usd: { type: "number", minimum: 0 },
        },
      },
    },
  },
};

const validatePriceTable = new Ajv2020({ allErrors: true, strict: false }).compile<PriceTableFile>(PRICE_TABLE_SCHEMA);

/** Read one auditable price table. Invalid tables fail before any paid session starts. */
export function loadPriceTable(file: string): PriceTable {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!validatePriceTable(raw))
    throw new Error(`${file}: ${validatePriceTable.errors?.map((error) => error.message).join("; ") ?? "invalid"}`);

  const models: Record<string, TokenPrice> = {};
  for (const [model, price] of Object.entries(raw.models)) {
    models[model] = {
      inputPerMillionUsd: price.input_per_million_usd,
      cachedInputPerMillionUsd: price.cached_input_per_million_usd,
      outputPerMillionUsd: price.output_per_million_usd,
    };
  }
  return { version: raw.version, asOf: raw.as_of, models };
}

/** Cached input and reasoning output are subsets of input and output respectively, so neither is double-counted. */
export function costOf(usage: TokenUsage, price: TokenPrice | undefined): number | undefined {
  if (price === undefined) return undefined;
  const uncachedInput = usage.inputTokens - usage.cachedInputTokens;
  return (
    (uncachedInput * price.inputPerMillionUsd +
      usage.cachedInputTokens * price.cachedInputPerMillionUsd +
      usage.outputTokens * price.outputPerMillionUsd) /
    1_000_000
  );
}

/**
 * The price table a matrix's `price-table` names, with the receipt fragment that records it.
 * Throws when the path leaves research/ or the table is invalid, before any paid session starts.
 */
export function matrixPrices(path: string | undefined) {
  if (path === undefined) return { prices: undefined, price_table: null };
  const file = resolve(PACKAGE_ROOT, path);
  const fromRoot = relative(resolve(PACKAGE_ROOT, "research"), file);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot))
    throw new Error(`price table must be a file under research/: ${path}`);
  const prices = loadPriceTable(file);
  return { prices, price_table: { path, version: prices.version, as_of: prices.asOf } };
}

/** Receipt fragment summing the token totals of the sessions that reported usage. */
export function usageReceipt(sessions: ReadonlyArray<Pick<SessionResult, "usage">>) {
  const reported = sessions.flatMap((session) => (session.usage === undefined ? [] : [session.usage]));
  const sum = (field: keyof TokenUsage) => reported.reduce((total, usage) => total + usage[field], 0);
  return {
    usage: {
      input_tokens: sum("inputTokens"),
      cached_input_tokens: sum("cachedInputTokens"),
      cache_write_input_tokens: sum("cacheWriteInputTokens"),
      output_tokens: sum("outputTokens"),
      reasoning_output_tokens: sum("reasoningOutputTokens"),
      total_tokens: sum("totalTokens"),
    },
    usage_sessions: reported.length,
  };
}
