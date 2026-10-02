/** Versioned token prices used to estimate Codex session cost. Not a test file. */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { TokenUsage } from "./subjects/types.ts";

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
  source?: string;
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
  required: ["version", "as_of", "models"],
  properties: {
    version: { type: "integer", minimum: 1 },
    as_of: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    source: { type: "string", minLength: 1 },
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
