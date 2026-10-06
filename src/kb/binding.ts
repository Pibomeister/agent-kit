import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

import commonSchema from "../../schemas/common.schema.json" with { type: "json" };
import bindingSchema from "../../schemas/kb-binding.schema.json" with { type: "json" };
import localGitSchema from "../../schemas/kb-backends/local-git.schema.json" with { type: "json" };
import { isDir, isInside, readTextIfPresent } from "../util/fs.ts";
import { error, note, warning, type Issue } from "../validation/types.ts";
import { commonDir, git, workTreeTop } from "./git.ts";

/**
 * How one project folder reaches its central knowledgebase
 * (adapters/knowledgebase/CONTRACT.md §7; ruling `kb-binding-is-a-locator`).
 *
 * The file is the small locator plan §1.2 lets a working repository hold. It
 * is committed and names no machine path, so a task copy of the project binds
 * what the main checkout binds; where the knowledgebase lives on this machine
 * is the operator's registration, kept outside every checkout.
 */
export const BINDING_FILE = "ak.kb.yaml";

/** Where a backend's own document and schema live, under this package's tree. */
export const BACKENDS_DIR = "adapters/knowledgebase/backends";
export const BACKEND_SCHEMAS_DIR = "schemas/kb-backends";

export interface KbBinding {
  backend: string;
  project: string;
  locator: Record<string, string>;
}

export interface KbBindingResult {
  /** Null when the folder binds nothing or the file does not parse as a binding. */
  binding: KbBinding | null;
  issues: Issue[];
}

/** One registered knowledgebase: the checkout this machine keeps it in. */
interface RegisteredKb {
  path: string;
}

interface KbRegistry {
  knowledgebases: Record<string, RegisteredKb>;
}

/** A binding resolved to a knowledgebase this machine can reach. */
export interface ResolvedKb {
  binding: KbBinding;
  /** The knowledgebase's id in the operator's registry. */
  knowledgebase: string;
  /** The knowledgebase checkout, by real path. */
  root: string;
}

export interface KbResolution {
  resolved: ResolvedKb | null;
  /**
   * Why nothing resolved, when nothing did: `unavailable` is no knowledgebase
   * configured for this checkout on this machine, `failed` is one that is
   * configured and cannot be used. The contract treats them differently
   * (CONTRACT.md §1): the first is reported and the run continues past a read,
   * the second stops it.
   */
  state: "available" | "unavailable" | "failed";
  issues: Issue[];
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(commonSchema);
const validBinding = ajv.compile<KbBinding>(bindingSchema);

/**
 * The backends this package carries. Compiled in, not read from the tree, so
 * the bundled `ak` checks a binding with no source checkout beside it; a test
 * holds this map equal to the documents in `BACKENDS_DIR`.
 */
export const BACKEND_VALIDATORS: ReadonlyMap<string, ValidateFunction<KbBinding>> = new Map([
  ["local-git", ajv.compile<KbBinding>(localGitSchema)],
]);

const validRegistry = ajv.compile<KbRegistry>({
  type: "object",
  additionalProperties: false,
  required: ["knowledgebases"],
  properties: {
    knowledgebases: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string", minLength: 1 } },
      },
    },
  },
});

/** How to bind and register, said once: every unavailable result ends with it. */
export const SETUP =
  `Bind the project by committing ${BINDING_FILE} at its root, and register the knowledgebase checkout once per machine with ` +
  "`ak kb register <knowledgebase-id> <path>`. ak.install.yaml is not part of this: it sets packaged mode ceilings and never makes a knowledgebase available.";

function describe(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .slice(0, 6)
    .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}`)
    .join("; ");
}

/**
 * Parse and shape-check the folder's binding. An absent file is a note and not
 * an error: an unbound folder is the unconfigured case the contract defines,
 * not a malformed one.
 */
export function loadKbBinding(projectRoot: string): KbBindingResult {
  const text = readTextIfPresent(join(projectRoot, BINDING_FILE));
  if (text === null) {
    return {
      binding: null,
      issues: [
        note(
          "kb.unbound",
          BINDING_FILE,
          `No binding: this folder reaches no knowledgebase, so kb-read returns unavailable and kb-write refuses (adapters/knowledgebase/CONTRACT.md §1). ${SETUP}`,
        ),
      ],
    };
  }
  let value: unknown;
  try {
    value = parseYaml(text, { uniqueKeys: true });
  } catch (cause) {
    const first = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
    return { binding: null, issues: [error("kb.binding-unparseable", BINDING_FILE, `Not valid YAML: ${first}`)] };
  }
  if (!validBinding(value)) {
    return {
      binding: null,
      issues: [
        error(
          "kb.binding-invalid",
          BINDING_FILE,
          `Does not match schemas/kb-binding.schema.json: ${describe(validBinding)}`,
        ),
      ],
    };
  }
  const id = value.backend;
  const backend = BACKEND_VALIDATORS.get(id);
  if (backend === undefined) {
    return {
      binding: null,
      issues: [
        error(
          "kb.backend-unknown",
          BINDING_FILE,
          `backend '${id}' has no document at ${BACKENDS_DIR}/${id}.md, so no operation knows how to reach it. A binding is added by writing that document (adapters/knowledgebase/CONTRACT.md §7).`,
        ),
      ],
    };
  }
  if (!backend(value)) {
    return {
      binding: null,
      issues: [
        error(
          "kb.binding-invalid",
          BINDING_FILE,
          `Does not match ${BACKEND_SCHEMAS_DIR}/${id}.schema.json: ${describe(backend)}`,
        ),
      ],
    };
  }
  return { binding: value, issues: [] };
}

/**
 * The folder whose binding governs `start`: the nearest directory at or above
 * it holding ak.kb.yaml, searching no higher than the git top level. A linked
 * work tree has its own top level and its own copy of the committed file, which
 * is why a task copy binds without any setup of its own. With no binding found,
 * `start` is returned and the folder reads as unbound.
 */
export function findKbProjectRoot(start: string): string {
  const from = realpathSync(start);
  const ceiling = workTreeTop(from) ?? from;
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, BINDING_FILE))) return dir;
    if (dir === ceiling || dirname(dir) === dir || relative(ceiling, dir).startsWith("..")) return from;
  }
}

/**
 * The operator's registry of knowledgebase checkouts on this machine. It lives
 * under the account's home, from the account record and not `HOME`, beside the
 * other state this package keeps outside every checkout; `AK_KB_REGISTRY`
 * names another file, which the tests use.
 */
export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AK_KB_REGISTRY ?? join(userInfo().homedir, ".agent-kit", "kb", "registry.json");
}

/** The registry as read: null with the reason when the file is there and is not one. */
interface RegistryRead {
  registry: KbRegistry | null;
  issues: Issue[];
}

function readRegistry(file: string): RegistryRead {
  const text = readTextIfPresent(file);
  if (text === null) return { registry: { knowledgebases: {} }, issues: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return {
      registry: null,
      issues: [
        error("kb.registry-invalid", file, `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`),
      ],
    };
  }
  if (!validRegistry(value)) {
    return {
      registry: null,
      issues: [error("kb.registry-invalid", file, `Not a knowledgebase registry: ${describe(validRegistry)}`)],
    };
  }
  return { registry: value, issues: [] };
}

/**
 * What is wrong with `root` as the knowledgebase of the project at
 * `projectRoot`, or nothing. A knowledgebase is a git repository of its own:
 * one that is a work tree of the project's repository, or sits inside its
 * tree, would turn every publish into a write to the application repository
 * (release scenario 21).
 */
function checkRoot(root: string, projectRoot: string | null): Issue[] {
  if (!isDir(root)) {
    return [error("kb.root-missing", root, "The registered knowledgebase checkout is not a directory.")];
  }
  const real = realpathSync(root);
  if (workTreeTop(real) !== real) {
    return [
      error(
        "kb.root-not-a-repository",
        root,
        "The registered knowledgebase checkout is not the top of a git work tree. A knowledgebase is a git repository of its own; create one with `git init` and register that directory.",
      ),
    ];
  }
  if (projectRoot === null) return [];
  const project = realpathSync(projectRoot);
  const projectTop = workTreeTop(project) ?? project;
  const sameRepository = commonDir(real) !== null && commonDir(real) === commonDir(project);
  if (sameRepository || isInside(real, projectTop) || isInside(projectTop, real)) {
    return [
      error(
        "kb.root-inside-project",
        root,
        "The registered knowledgebase checkout is the project's own repository or shares a tree with it. Project knowledge is never written into the application repository (adapters/knowledgebase/CONTRACT.md §3), so every operation refuses.",
      ),
    ];
  }
  return [];
}

/**
 * Record where knowledgebase `id` is checked out on this machine. The
 * operator's step, run once: it writes the registry and nothing else, and
 * refuses a path that is not a git repository of its own.
 */
export function registerKnowledgebase(file: string, id: string, path: string, cwd: string): Issue[] {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    return [
      error("kb.register-id", "-", `'${id}' is not a knowledgebase id: lowercase words joined by single hyphens.`),
    ];
  }
  const target = isAbsolute(path) ? path : join(cwd, path);
  const projectRoot = findKbProjectRoot(cwd);
  const rootIssues = checkRoot(target, existsSync(join(projectRoot, BINDING_FILE)) ? projectRoot : null);
  if (rootIssues.length > 0) return rootIssues;
  const loaded = readRegistry(file);
  if (loaded.registry === null) return loaded.issues;
  const next: KbRegistry = {
    knowledgebases: { ...loaded.registry.knowledgebases, [id]: { path: realpathSync(target) } },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return [];
}

/**
 * Resolve the binding of the project at `projectRoot` to a knowledgebase this
 * machine can reach, or say which of the two ways it cannot.
 */
export function resolveKnowledgebase(projectRoot: string, registryFile: string): KbResolution {
  const loaded = loadKbBinding(projectRoot);
  if (loaded.binding === null) {
    const unbound = loaded.issues.every((issue) => issue.rule === "kb.unbound");
    return { resolved: null, state: unbound ? "unavailable" : "failed", issues: loaded.issues };
  }
  const binding = loaded.binding;
  const id = binding.locator["knowledgebase"] ?? "";
  const registry = readRegistry(registryFile);
  if (registry.registry === null) return { resolved: null, state: "failed", issues: registry.issues };
  const entry = registry.registry.knowledgebases[id];
  if (entry === undefined) {
    return {
      resolved: null,
      state: "unavailable",
      issues: [
        warning(
          "kb.unregistered",
          BINDING_FILE,
          `Bound to knowledgebase '${id}', which this machine has not registered (${registryFile}), so kb-read returns unavailable and kb-write refuses. ${SETUP}`,
        ),
      ],
    };
  }
  const rootIssues = checkRoot(entry.path, projectRoot);
  if (rootIssues.length > 0) return { resolved: null, state: "failed", issues: rootIssues };
  const root = realpathSync(entry.path);
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    return {
      resolved: null,
      state: "failed",
      issues: [error("kb.root-not-a-repository", entry.path, "git cannot read the registered knowledgebase checkout.")],
    };
  }
  return { resolved: { binding, knowledgebase: id, root }, state: "available", issues: [] };
}
