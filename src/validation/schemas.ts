import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

import { CATALOG_FILE } from "../catalog/load.ts";
import { INSTALL_FILE } from "../packaging/install.ts";
import { listDirs, listFiles, readTextIfPresent } from "../util/fs.ts";
import type { CheckContext } from "./context.ts";
import { documentFiles, documentShape } from "./documents.ts";
import { CASE_FILE, EVALS_DIR } from "./evals.ts";
import { RULINGS_FILE } from "./rulings.ts";
import { error, skipped, type Issue } from "./types.ts";

type AjvInstance = InstanceType<typeof Ajv2020>;

export interface SchemaSet {
  ajv: AjvInstance;
  issues: Issue[];
  /**
   * Validator for a catalog schema id, e.g. "ticket". Undefined when absent or uncompilable.
   *
   * `pointer` selects a definition inside that schema instead of its root, e.g.
   * `#/$defs/fragment`, for a document that is one part of a schema's subject
   * rather than all of it. It resolves only inside a schema that itself
   * compiled, so an uncompilable schema has no parts either.
   */
  validatorFor(id: string, pointer?: string): ValidateFunction | undefined;
  ids(): string[];
}

/** The definition in catalog.schema.json that a catalog.d/ fragment validates against. */
export const CATALOG_FRAGMENT_POINTER = "#/$defs/fragment";

/** `common` holds shared $defs and validates no document itself. */
const NON_DOCUMENT_SCHEMAS = new Set(["common"]);

function schemaIdFromFile(name: string): string {
  return name.replace(/\.schema\.json$/, "");
}

/**
 * Duplicate keys are legal to JSON.parse (last wins) and silently change a
 * contract. The YAML parser rejects them and reports a position.
 */
function duplicateKeyIssue(file: string, text: string): Issue | null {
  try {
    parseYaml(text, { uniqueKeys: true });
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/unique/i.test(message)) return null;
    const line = /at line (\d+)/.exec(message)?.[1];
    const first = message.split("\n")[0] ?? message;
    return error("schemas.duplicate-json-key", file, first, line === undefined ? undefined : Number(line));
  }
}

export function compileSchemas(root: string): SchemaSet {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);

  const issues: Issue[] = [];
  const parsed: Array<{ id: string; file: string; schema: Record<string, unknown> }> = [];

  for (const name of listFiles(join(root, "schemas"))) {
    if (!name.endsWith(".schema.json")) continue;
    const file = `schemas/${name}`;
    const text = readTextIfPresent(join(root, file));
    if (text === null) continue;

    const dup = duplicateKeyIssue(file, text);
    if (dup !== null) issues.push(dup);

    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch (cause) {
      issues.push(
        error("schemas.unparseable", file, `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
      continue;
    }
    if (schema === null || typeof schema !== "object") {
      issues.push(error("schemas.unparseable", file, "Schema is not an object."));
      continue;
    }
    parsed.push({ id: schemaIdFromFile(name), file, schema: schema as Record<string, unknown> });
  }

  for (const { file, schema } of parsed) {
    try {
      ajv.addSchema(schema);
    } catch (cause) {
      issues.push(
        error(
          "schemas.uncompilable",
          file,
          `ajv rejected the schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  const validators = new Map<string, ValidateFunction>();
  const baseIds = new Map<string, string>();
  for (const { id, file, schema } of parsed) {
    const $id = typeof schema["$id"] === "string" ? schema["$id"] : undefined;
    try {
      const validate = $id === undefined ? ajv.compile(schema) : ajv.getSchema($id);
      if (validate !== undefined) {
        validators.set(id, validate);
        if ($id !== undefined) baseIds.set(id, $id);
      } else issues.push(error("schemas.uncompilable", file, `No compiled validator for $id ${$id}.`));
    } catch (cause) {
      issues.push(
        error(
          "schemas.uncompilable",
          file,
          `ajv could not compile it: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  return {
    ajv,
    issues,
    validatorFor: (id, pointer) => {
      if (pointer === undefined) return validators.get(id);
      const base = baseIds.get(id);
      if (base === undefined) return undefined;
      try {
        return ajv.getSchema(`${base}${pointer}`);
      } catch {
        return undefined;
      }
    },
    ids: () => [...validators.keys()].sort(),
  };
}

function describeErrors(validate: ValidateFunction): string {
  const errors = validate.errors ?? [];
  return errors
    .slice(0, 6)
    .map((e) => {
      const where = e.instancePath === "" ? "(root)" : e.instancePath;
      const extra = "params" in e && e.params !== undefined ? ` ${JSON.stringify(e.params)}` : "";
      return `${where} ${e.message ?? "is invalid"}${extra}`;
    })
    .join("; ");
}

function loadDocument(root: string, file: string): { value: unknown } | { failure: Issue } {
  const text = readTextIfPresent(join(root, file));
  if (text === null) return { failure: error("schemas.document-unreadable", file, "File could not be read.") };
  try {
    const value = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    return { value };
  } catch (cause) {
    return {
      failure: error("schemas.document-unparseable", file, cause instanceof Error ? cause.message : String(cause)),
    };
  }
}

interface Target {
  file: string;
  schemaId: string;
  /** A definition inside the schema to validate against instead of its root. */
  pointer?: string;
}

function documentTargets(ctx: CheckContext): Target[] {
  const { root, catalog } = ctx;
  const targets: Target[] = [{ file: CATALOG_FILE, schemaId: "catalog" }];
  // Each fragment the loader merged, against the fragment shape rather than the
  // whole catalog's: a fragment is one part of the catalog and never carries
  // the sections it does not add to. One the loader could not read is already
  // reported by it and is not offered here a second time.
  for (const file of catalog.fragments) targets.push({ file, schemaId: "catalog", pointer: CATALOG_FRAGMENT_POINTER });

  for (const entry of catalog.bySection("skills")) {
    const file = `skills/${entry.id}/skill.yaml`;
    if (readTextIfPresent(join(root, file)) !== null) targets.push({ file, schemaId: "skill" });
  }
  for (const entry of catalog.bySection("packs")) {
    for (const name of ["pack.yaml", "manifest.yaml"]) {
      const file = `packs/${entry.id}/${name}`;
      if (readTextIfPresent(join(root, file)) !== null) targets.push({ file, schemaId: "pack" });
    }
  }
  // Executable eval cases. Reached through the catalog's skills, the same way
  // checkEvals reaches them, so a case under a directory no skill claims is
  // still `evals.case-without-declaration`'s to report and does not become a
  // schema error as well. The constants come from evals.ts rather than being
  // spelled again, because the layout is that file's to define.
  for (const entry of catalog.bySection("skills")) {
    for (const caseId of listDirs(join(root, EVALS_DIR, entry.id))) {
      const file = `${EVALS_DIR}/${entry.id}/${caseId}/${CASE_FILE}`;
      if (readTextIfPresent(join(root, file)) !== null) targets.push({ file, schemaId: "case" });
    }
  }
  // The resolved-conflicts policy. Its path comes from rulings.ts, which is the
  // file that owns where it lives; the other `policies/*.yaml` are not targets
  // because no schema declares them, and adding one here for a schema that does
  // not exist would report every policy as validating against nothing.
  if (readTextIfPresent(join(root, RULINGS_FILE)) !== null) {
    targets.push({ file: RULINGS_FILE, schemaId: "rulings" });
  }
  // The per-install configuration, when this install has one. Its absence is
  // the default and not a missing document, so nothing is reported for it.
  if (readTextIfPresent(join(root, INSTALL_FILE)) !== null) {
    targets.push({ file: INSTALL_FILE, schemaId: "install" });
  }
  return targets;
}

/**
 * Every example artifact under templates/ declares the schema it conforms to in
 * its envelope `schema` field (schemas/common.schema.json#/$defs/schema_id),
 * so the validator does not have to guess from the filename.
 */
function templateTargets(ctx: CheckContext): Array<Target | Issue> {
  const out: Array<Target | Issue> = [];
  for (const file of documentFiles(ctx.root)) {
    const loaded = loadDocument(ctx.root, file);
    if ("failure" in loaded) {
      out.push(loaded.failure);
      continue;
    }
    const shape = documentShape(loaded.value);
    // Not a document, so ajv is given nothing to validate. checkTemplateDocuments
    // (documents.ts) owns every reason a file reaches this line, which is why the
    // skip loses no evidence; do not add a fourth reason here without adding it there.
    if (shape.kind !== "document") continue;
    out.push({ file, schemaId: shape.schema });
  }
  return out;
}

export function checkSchemas(ctx: CheckContext, precompiled?: SchemaSet): Issue[] {
  const set = precompiled ?? compileSchemas(ctx.root);
  const issues: Issue[] = [...set.issues];
  const unavailable = new Set<string>();

  const targets: Target[] = [];
  for (const t of [...documentTargets(ctx), ...templateTargets(ctx)]) {
    if ("severity" in t) issues.push(t);
    else targets.push(t);
  }

  for (const target of targets) {
    if (NON_DOCUMENT_SCHEMAS.has(target.schemaId)) continue;
    const validate = set.validatorFor(target.schemaId, target.pointer);
    if (validate === undefined) {
      const declared = ctx.catalog.get("schemas", target.schemaId);
      if (declared === undefined && target.file.startsWith("templates/")) {
        issues.push(
          error(
            "schemas.unknown-schema-id",
            target.file,
            `Artifact declares schema '${target.schemaId}', which is not a catalog schema.`,
          ),
        );
        continue;
      }
      const wanted = `${target.schemaId}${target.pointer ?? ""}`;
      if (!unavailable.has(wanted)) {
        unavailable.add(wanted);
        issues.push(
          skipped(
            "schemas.validator-unavailable",
            `schemas/${target.schemaId}.schema.json`,
            "schema conformance",
            `No compiled validator for '${wanted}'; documents that need it were not checked.`,
          ),
        );
      }
      continue;
    }

    const loaded = loadDocument(ctx.root, target.file);
    if ("failure" in loaded) {
      issues.push(loaded.failure);
      continue;
    }
    if (!validate(loaded.value)) {
      issues.push(
        error(
          "schemas.document-invalid",
          target.file,
          `Does not validate against ${target.schemaId}.schema.json${target.pointer ?? ""}: ${describeErrors(validate)}`,
        ),
      );
    }
  }

  return issues;
}
