/** Validating a binding against schemas/firstmate-binding.schema.json, with the package's own compiler. */
import { compileSchemas, type SchemaSet } from "../validation/schemas.ts";

export interface Binding {
  schema: "firstmate-binding";
  schema_version: 1;
  task_id: string;
  run_id: string;
  project: { id: string; path: string; repo?: string; workspace?: string };
  work_source: { kind: "firstmate-brief" | "ticket" | "prompt"; ref?: string; hash?: string };
  source_snapshot: { repo: string; revision: string; diff_hash: string };
  skill_bundle: { version: string; host: "claude-code" | "codex"; hash: string; path: string };
  charter: { ref: string; hash: string } | null;
  required_gates: string[];
  packs?: string[];
  child_budget: { max_children: number; max_concurrent: number; max_depth: 1; charged_to: string; roles: string[] };
  evidence: { store: "kb" | "mock"; location: string; label?: string };
  delivery: { action: "publish" | "dry-run"; transport: "no-mistakes"; skip: string[]; merge: false };
  upstream: { commit: string; patch: string };
  created_at: string;
}

const cache = new Map<string, SchemaSet>();

/** Every reason the binding does not validate, as `<path> <message>`; empty when it does. */
export function validateBinding(akRoot: string, binding: unknown): string[] {
  let set = cache.get(akRoot);
  if (set === undefined) {
    set = compileSchemas(akRoot, ["common", "firstmate-binding"]);
    cache.set(akRoot, set);
  }
  const validate = set.validatorFor("firstmate-binding");
  if (validate === undefined) return ["schemas/firstmate-binding.schema.json did not compile"];
  if (validate(binding)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
}
