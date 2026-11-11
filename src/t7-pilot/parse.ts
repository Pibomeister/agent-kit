import Ajv2020 from "ajv/dist/2020.js";

import schema from "../../research/t7-pilot/evidence.schema.json" with { type: "json" };
import type { T7Evidence } from "./types.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validator = ajv.compile<T7Evidence>(schema);

export function parseT7Evidence(text: string): T7Evidence | null {
  try {
    // SAFETY: JSON.parse is any; validator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return validator(value) ? value : null;
  } catch {
    return null;
  }
}
