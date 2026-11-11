import Ajv2020 from "ajv/dist/2020.js";

import schema from "../../research/held-out/evidence.schema.json" with { type: "json" };
import type { T4Evidence } from "./types.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validator = ajv.compile<T4Evidence>(schema);

export function parseT4Evidence(text: string): T4Evidence | null {
  try {
    // SAFETY: JSON.parse is any; validator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return validator(value) ? value : null;
  } catch {
    return null;
  }
}
