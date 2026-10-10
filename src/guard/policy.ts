import type { ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

import { readTextIfPresent } from "../util/fs.ts";
import { compileSchemas } from "../validation/schemas.ts";
import { error, type Issue } from "../validation/types.ts";
import { compileGlob } from "./glob.ts";

/**
 * The guard policy (schemas/guard-policy.schema.json): the data the evaluator
 * in evaluate.ts judges a tool call against. Hand-written until the
 * constitution compiler emits it, and loaded only through `parseGuardPolicy`,
 * which applies the schema and then the two checks a schema cannot state.
 */
export type ProtectedCategory =
  | "tests"
  | "ci-config"
  | "lint-config"
  | "architecture-config"
  | "baselines"
  | "codeowners"
  | "hook-config"
  | "registry"
  | "other";

export interface ProtectedPath {
  id: string;
  category: ProtectedCategory;
  globs: string[];
  reason: string;
}

export interface DestructiveCommand {
  id: string;
  program: string;
  subcommand?: string;
  all_of?: string[][];
  reason: string;
}

export interface SecretPath {
  id: string;
  globs: string[];
  reason: string;
}

export interface PathTier {
  id: string;
  tier: "never" | "ask-first";
  globs: string[];
  reason: string;
}

export interface GovernedArticle {
  id: string;
  version: string;
  rule: string;
}

export interface GovernedPath {
  id: string;
  globs: string[];
  articles: GovernedArticle[];
}

export interface GuardPolicy {
  version: string;
  protected_paths: ProtectedPath[];
  destructive_commands: DestructiveCommand[];
  secret_paths: SecretPath[];
  path_tiers: PathTier[];
  governed_paths: GovernedPath[];
}

export interface PolicyResult {
  /** Null whenever an issue was found: a policy that is partly wrong is not judged by. */
  policy: GuardPolicy | null;
  issues: Issue[];
}

export const SCHEMA_ID = "guard-policy";

/** Every rule id the policy declares, in file order. */
export function policyRuleIds(policy: GuardPolicy): string[] {
  return [
    ...policy.protected_paths.map((r) => r.id),
    ...policy.destructive_commands.map((r) => r.id),
    ...policy.secret_paths.map((r) => r.id),
    ...policy.path_tiers.map((r) => r.id),
    ...policy.governed_paths.map((r) => r.id),
  ];
}

function policyGlobs(policy: GuardPolicy): string[] {
  return [
    ...policy.protected_paths.flatMap((r) => r.globs),
    ...policy.secret_paths.flatMap((r) => r.globs),
    ...policy.path_tiers.flatMap((r) => r.globs),
    ...policy.governed_paths.flatMap((r) => r.globs),
  ];
}

/** What the schema cannot state: rule ids are unique across sections, and every glob's braces balance. */
export function checkPolicy(policy: GuardPolicy, file: string): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const id of policyRuleIds(policy)) {
    if (seen.has(id)) {
      issues.push(error("guard.policy-duplicate-rule-id", file, `Rule id '${id}' is declared more than once.`));
    }
    seen.add(id);
  }
  for (const glob of new Set(policyGlobs(policy))) {
    if (compileGlob(glob) === null) {
      issues.push(error("guard.policy-bad-glob", file, `Glob '${glob}' has unbalanced braces.`));
    }
  }
  return issues;
}

/** The schema's verdict, as the type the schema describes. */
function conforms(validate: ValidateFunction, value: unknown): value is GuardPolicy {
  return validate(value);
}

/**
 * Parse policy text (YAML, so JSON too) and check it against the schema and
 * `checkPolicy`. `validate` is the validator compiled from
 * schemas/guard-policy.schema.json, whose shape GuardPolicy mirrors.
 */
export function parseGuardPolicy(text: string, validate: ValidateFunction, file: string): PolicyResult {
  let value: unknown;
  try {
    value = parseYaml(text, { uniqueKeys: true });
  } catch (cause) {
    const first = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
    return { policy: null, issues: [error("guard.policy-unparseable", file, `Not valid YAML: ${first}`)] };
  }
  if (!conforms(validate, value)) {
    const detail = (validate.errors ?? [])
      .slice(0, 6)
      .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}`)
      .join("; ");
    return {
      policy: null,
      issues: [error("guard.policy-invalid", file, `Does not match schemas/guard-policy.schema.json: ${detail}`)],
    };
  }
  const issues = checkPolicy(value, file);
  return { policy: issues.length === 0 ? value : null, issues };
}

/**
 * Read and check the policy at `file`. `schemaRoot` is this package's tree,
 * where the schema lives, not the project the policy is about.
 */
export function loadGuardPolicy(file: string, schemaRoot: string): PolicyResult {
  const text = readTextIfPresent(file);
  if (text === null) {
    return { policy: null, issues: [error("guard.policy-missing", file, "No guard policy file at this path.")] };
  }
  const validate = compileSchemas(schemaRoot).validatorFor(SCHEMA_ID);
  if (validate === undefined) {
    return {
      policy: null,
      issues: [
        error(
          "guard.policy-schema-missing",
          file,
          "schemas/guard-policy.schema.json did not compile, so the policy cannot be checked and is not trusted.",
        ),
      ],
    };
  }
  return parseGuardPolicy(text, validate, file);
}
