/**
 * Bundled into `bin/ak-gate.mjs` with `gate.ts`, so this file imports only `node:` built-ins.
 */

type DesignReport = { readonly schema: "review" };

function isNonArrayObject(value: unknown): value is object {
  return !Array.isArray(value) && Object(value) === value;
}

/** Narrow tripwire: a JSON object with schema === "review". Wrapped objects, other schema values, and Markdown or YAML reports are not caught. */
export function isDesignReport(value: unknown): value is DesignReport {
  return isNonArrayObject(value) && "schema" in value && value.schema === "review";
}
