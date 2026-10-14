import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** The source CLI and standalone emitter compile the same two schema documents. */
export function compileVerificationSchema(root = fileURLToPath(new URL("../..", import.meta.url))) {
  const ajv = new Ajv2020({
    strictTypes: false,
    keywords: ["x-validator-rule"],
    allErrors: true,
    validateFormats: true,
    code: { source: true, esm: true },
  });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(readFileSync(join(root, "schemas/common.schema.json"), "utf8")));
  const validate = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/verification.schema.json"), "utf8")));
  return { ajv, validate };
}

let compiled: ReturnType<typeof compileVerificationSchema>["validate"] | undefined;

/** Compiled on first use. The standalone builder replaces this module with its generated accessor. */
export function verificationValidator() {
  compiled ??= compileVerificationSchema().validate;
  return compiled;
}
