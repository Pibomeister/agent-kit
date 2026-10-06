import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** The source CLI and standalone emitter compile the same two schema documents. */
export function compileVerificationSchema(root = join(import.meta.dir, "..", "..")) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, code: { source: true, esm: true } });
  addFormats(ajv);
  ajv.addSchema(JSON.parse(readFileSync(join(root, "schemas/common.schema.json"), "utf8")));
  const validate = ajv.compile(JSON.parse(readFileSync(join(root, "schemas/verification.schema.json"), "utf8")));
  return { ajv, validate };
}

export default compileVerificationSchema().validate;
