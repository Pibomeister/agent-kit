import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";

import { readTextIfPresent } from "../util/fs.ts";
import { error, note, warning, type Issue } from "../validation/types.ts";
import { compileSchemas } from "../validation/schemas.ts";

/**
 * How one project folder reaches its ticket backend (adapters/tracker/CONTRACT.md §5).
 *
 * At the root of the project the tickets are about, not of this package: a
 * binding is a fact about one checkout, and two folders on one machine bind
 * two workspaces. It holds no secret and is committed, so every checkout of the
 * project binds the same backend and team; the secret is the gitignored file
 * `token_file` names, and it is the operator's (ruling
 * `tracker-of-record-falls-back-to-kb`).
 */
export const BINDING_FILE = "ak.tracker.yaml";

export interface TrackerBinding {
  backend: string;
  token_file: string;
  defaults: Record<string, string>;
  statuses?: Record<string, string>;
}

export interface BindingResult {
  /** Null when the folder binds nothing or the file does not parse as a binding. */
  binding: TrackerBinding | null;
  issues: Issue[];
}

/** Embedded validators let the standalone maintenance command use these same checks without a source checkout. */
export interface BindingValidators {
  binding: ValidateFunction<TrackerBinding>;
  backends: ReadonlyMap<string, ValidateFunction<TrackerBinding>>;
}

/**
 * Parse and shape-check the folder's binding against `schemas/tracker-binding.schema.json`.
 *
 * `schemaRoot` is this package's tree, where the schema lives, and not the
 * project folder, which carries no schemas. An absent file is a note and not an
 * error: an unbound folder is the case the knowledgebase chain covers
 * (CONTRACT.md §2), not a malformed one.
 */
export function loadTrackerBinding(
  projectRoot: string,
  schemaRoot: string,
  embedded?: BindingValidators,
): BindingResult {
  const text = readTextIfPresent(join(projectRoot, BINDING_FILE));
  if (text === null) {
    return {
      binding: null,
      issues: [
        note(
          "tracker.unbound",
          BINDING_FILE,
          "No binding: this folder reaches no backend, so the knowledgebase's ticket records are the system of record when the project record agrees, and every ticket operation refuses otherwise (adapters/tracker/CONTRACT.md §2).",
        ),
      ],
    };
  }
  let value: unknown;
  try {
    value = parseYaml(text, { uniqueKeys: true });
  } catch (cause) {
    const first = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
    return { binding: null, issues: [error("tracker.binding-unparseable", BINDING_FILE, `Not valid YAML: ${first}`)] };
  }
  const validate = embedded?.binding ?? compileSchemas(schemaRoot).validatorFor("tracker-binding");
  if (validate === undefined) {
    return {
      binding: null,
      issues: [
        error(
          "tracker.binding-schema-missing",
          BINDING_FILE,
          "schemas/tracker-binding.schema.json did not compile, so the binding cannot be checked and is not trusted.",
        ),
      ],
    };
  }
  if (!validate(value)) {
    // Messages name the path and the constraint, never the value: a token
    // pasted under an unknown key is one error this reports, and echoing the
    // offending value would print it.
    const detail = (validate.errors ?? [])
      .slice(0, 6)
      .map(
        (e) =>
          `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}${e.keyword === "additionalProperties" ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})` : ""}`,
      )
      .join("; ");
    return {
      binding: null,
      issues: [
        error("tracker.binding-invalid", BINDING_FILE, `Does not match schemas/tracker-binding.schema.json: ${detail}`),
      ],
    };
  }
  const binding = value as TrackerBinding;
  const backendIssues = checkBackend(binding, schemaRoot, embedded?.backends);
  return { binding: backendIssues.length === 0 ? binding : null, issues: backendIssues };
}

/** Where a binding's own document and optional schema live, under this package's tree. */
export const BACKENDS_DIR = "adapters/tracker/backends";
export const BACKEND_SCHEMAS_DIR = "schemas/tracker-backends";

/**
 * The backend half of the shape check. The generic schema names no vendor
 * (CONTRACT.md §5), so a backend's own constraints on `defaults` live in
 * `schemas/tracker-backends/<id>.schema.json` beside its document, and a backend
 * with no document is not a binding this package can describe to anyone.
 */
function checkBackend(
  binding: TrackerBinding,
  schemaRoot: string,
  embedded?: ReadonlyMap<string, ValidateFunction<TrackerBinding>>,
): Issue[] {
  const id = binding.backend;
  if (embedded ? !embedded.has(id) : !existsSync(join(schemaRoot, BACKENDS_DIR, `${id}.md`))) {
    return [
      error(
        "tracker.backend-unknown",
        BINDING_FILE,
        `backend '${id}' has no document at ${BACKENDS_DIR}/${id}.md, so no operation knows how to reach it. A binding is added by writing that document (adapters/tracker/CONTRACT.md §5).`,
      ),
    ];
  }
  const file = `${BACKEND_SCHEMAS_DIR}/${id}.schema.json`;
  const embeddedValidator = embedded?.get(id);
  if (embeddedValidator !== undefined) {
    if (embeddedValidator(binding)) return [];
    const detail = (embeddedValidator.errors ?? [])
      .slice(0, 6)
      .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}`)
      .join("; ");
    return [error("tracker.binding-invalid", BINDING_FILE, `Does not match ${file}: ${detail}`)];
  }
  const text = readTextIfPresent(join(schemaRoot, file));
  if (text === null) return [];
  let validate;
  try {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    validate = ajv.compile(JSON.parse(text) as object);
  } catch (cause) {
    return [
      error(
        "tracker.binding-schema-missing",
        BINDING_FILE,
        `${file} did not compile, so the binding cannot be checked and is not trusted: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    ];
  }
  if (validate(binding)) return [];
  const detail = (validate.errors ?? [])
    .slice(0, 6)
    .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "is invalid"}`)
    .join("; ");
  return [error("tracker.binding-invalid", BINDING_FILE, `Does not match ${file}: ${detail}`)];
}

/**
 * The folder `ak tracker check` should read: the nearest directory at or above
 * `start` holding ak.tracker.yaml, searching no higher than the git top level,
 * so running it from `src/` of a bound project checks that project. Outside a
 * repository only `start` itself is read. With no binding found, `start` is
 * returned, and the check reports the folder unbound.
 */
export function findProjectRoot(start: string): string {
  const from = realpathSync(start);
  const top = git(from, ["rev-parse", "--show-toplevel"]);
  const ceiling = top.status === 0 ? realpathSync(top.stdout.trim()) : from;
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, BINDING_FILE))) return dir;
    if (dir === ceiling || dirname(dir) === dir || relative(ceiling, dir).startsWith("..")) return from;
  }
}

/**
 * Git as this check needs it: pathspecs taken literally, so a token_file named
 * `*` or `:(top)x` is that file and not a pattern, and no `GIT_*` variable from
 * the caller -- `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` set by a hook
 * would point every answer at another repository. `check-ignore` refuses
 * literal pathspec magic, so it is called with `literal: false` and given its
 * path on stdin -- prefixed with `./`, because stdin paths are still parsed as
 * pathspecs and `:(top)x` would otherwise be checked as `x`.
 */
function git(root: string, args: string[], options: { input?: string; timeout?: number; literal?: boolean } = {}) {
  const { literal = true, ...spawn } = options;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return spawnSync("git", [...(literal ? ["--literal-pathspecs"] : []), "-C", root, ...args], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    ...spawn,
  });
}

/** How long the history scan may run before it is reported as not run. */
export const HISTORY_TIMEOUT_MS = 30_000;

/**
 * Whether `file` is ignored, and by which rule. Ignored is decided by
 * `check-ignore -q`, which applies `!` negations the way `git add` does; `-v`
 * is asked only for the rule's source, NUL-separated because a path may hold
 * `:`. A match whose pattern starts with `!` un-ignores the file, so it is never
 * taken as the ignoring rule.
 */
function ignoringRule(root: string, file: string): { source: string; pattern: string } | null {
  const input = `./${file}\0`;
  if (git(root, ["check-ignore", "-q", "-z", "--stdin", "--no-index"], { input, literal: false }).status !== 0)
    return null;
  const verbose = git(root, ["check-ignore", "-v", "-z", "--stdin", "--no-index"], { input, literal: false });
  if (verbose.status !== 0) return null;
  const [source = "", , pattern = ""] = verbose.stdout.split("\0");
  if (pattern.startsWith("!")) return null;
  return { source, pattern };
}

/**
 * Whether the .gitignore files committed at HEAD ignore `file`, decided by git
 * itself: the committed .gitignore of each directory above the file -- the only
 * ones that can reach it -- is written at its own path into a scratch
 * repository, which has no other rules -- no template, no info/exclude, no
 * global excludes file -- and check-ignore runs there on the path from the
 * repository top. So a negation committed after the rule, or a rule present
 * only in the working tree, counts exactly as it would in a fresh clone.
 */
function ignoredAtHead(root: string, file: string): boolean {
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  if (prefix.status !== 0) return false;
  const path = `${prefix.stdout.trim()}${file}`;
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  const scratch = mkdtempSync(join(tmpdir(), "ak-ignore-"));
  try {
    if (git(scratch, ["init", "-q", "--template="]).status !== 0) return false;
    for (let depth = 0; depth < segments.length; depth++) {
      const rules = [...segments.slice(0, depth), ".gitignore"].join("/");
      const listed = git(root, ["ls-tree", "-z", "--full-tree", "HEAD", "--", rules]);
      if (listed.status !== 0) return false;
      const entry = listed.stdout.split("\0")[0] ?? "";
      const [mode, type, object] = entry.slice(0, entry.indexOf("\t")).split(" ");
      if (type !== "blob" || mode === "120000") continue;
      const blob = git(root, ["cat-file", "blob", object ?? ""]);
      if (blob.status !== 0) return false;
      mkdirSync(join(scratch, ...segments.slice(0, depth)), { recursive: true });
      writeFileSync(join(scratch, rules), blob.stdout);
    }
    const excludes = `core.excludesFile=${join(scratch, ".git", "no-excludes")}`;
    return (
      git(scratch, ["-c", excludes, "check-ignore", "-q", "-z", "--stdin", "--no-index"], {
        input: `./${path}\0`,
        literal: false,
      }).status === 0
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The secret-handling checks: the ones that fail if a token could leave the operator's machine or be missed.
 *
 * Reads the secret only to learn whether it is blank and never puts its
 * contents in a message. Blank is an error and not a nicety: linearis treats an
 * empty `LINEAR_API_TOKEN` as absent and falls through to the operator-global
 * token, which is the cross-project write the binding exists to prevent
 * (adapters/tracker/backends/linear-linearis.md §3).
 */
export function checkTrackerSecret(
  projectRoot: string,
  binding: TrackerBinding,
  historyTimeoutMs = HISTORY_TIMEOUT_MS,
): Issue[] {
  const issues: Issue[] = [];
  const file = binding.token_file;
  const path = join(projectRoot, file);

  // The schema's repo_path refuses `..` and absolute paths; a symlink can still
  // point out of the folder, and a secret outside it is not project-local.
  const text = readTextIfPresent(path);
  if (text !== null) {
    const inside = relative(realpathSync(projectRoot), realpathSync(path));
    if (inside.startsWith("..") || isAbsolute(inside)) {
      issues.push(
        error(
          "tracker.secret-outside-project",
          file,
          "token_file resolves outside the project folder. The secret is project-local (CONTRACT.md §5), so a link to a shared or global token is refused.",
        ),
      );
    }
  }
  if (text === null) {
    issues.push(
      error(
        "tracker.secret-absent",
        file,
        "token_file does not exist. Every ticket operation refuses before invoking the backend until the operator creates it (CONTRACT.md §5).",
      ),
    );
  } else if (text.trim() === "") {
    issues.push(
      error(
        "tracker.secret-empty",
        file,
        `token_file is blank (${statSync(path).size} bytes). A blank token is refused rather than passed, because the backend would treat it as absent and reach for an operator-global credential.`,
      ),
    );
  }
  if (text !== null && (statSync(path).mode & 0o044) !== 0) {
    issues.push(
      warning(
        "tracker.secret-readable-by-others",
        file,
        "token_file is readable by its group or by other users of this machine. Restrict it to its owner: chmod 600.",
      ),
    );
  }

  const top = git(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    issues.push(
      warning(
        "tracker.not-a-git-repository",
        file,
        "Not inside a git repository, so whether the secret is ignored, tracked or in history was not checked.",
      ),
    );
    return issues;
  }

  if (git(projectRoot, ["ls-files", "--error-unmatch", "--", file]).status === 0) {
    issues.push(
      error(
        "tracker.secret-tracked",
        file,
        "token_file is tracked by git. Remove it from the index and rotate the token: nothing token-bearing is committed (CONTRACT.md §5).",
      ),
    );
  }

  // A project .gitignore, specifically: it protects every operator who follows
  // the binding's path, where a global excludes file protects only the one
  // machine that has it.
  const source = ignoringRule(projectRoot, file)?.source ?? "";
  if (source === "" || isAbsolute(source) || basename(source) !== ".gitignore") {
    issues.push(
      error(
        "tracker.secret-not-ignored",
        file,
        "token_file is not ignored by a .gitignore in this repository. Add it to the project's .gitignore, so no operator following this binding can stage it.",
      ),
    );
  } else if (!ignoredAtHead(projectRoot, file)) {
    // An untracked .gitignore, or a rule not yet committed to a tracked one, is
    // machine-local in the same way: the next clone has no rule.
    issues.push(
      error(
        "tracker.secret-not-ignored",
        file,
        `token_file is ignored only by an uncommitted rule in ${source}. Commit that .gitignore rule, so every clone of the project ignores it.`,
      ),
    );
  }

  const history = git(projectRoot, ["log", "--all", "--full-history", "--format=%h", "-1", "--", file], {
    timeout: historyTimeoutMs,
  });
  if (history.status !== 0) {
    const why =
      history.error !== undefined || history.signal !== null
        ? `did not finish within ${historyTimeoutMs} ms`
        : "failed";
    issues.push(
      warning(
        "tracker.history-unreadable",
        file,
        `git log ${why}, so whether token_file was ever committed was not checked.`,
      ),
    );
  } else if (history.stdout.trim() !== "") {
    issues.push(
      error(
        "tracker.secret-in-history",
        file,
        `token_file appears in commit ${history.stdout.trim()}. Untracking it now does not remove it from history: rotate the token.`,
      ),
    );
  }
  return issues;
}

/** `ak tracker check`: the binding's shape and backend, then its secret, in that order. */
export function checkTrackerBinding(projectRoot: string, schemaRoot: string, embedded?: BindingValidators): Issue[] {
  const loaded = loadTrackerBinding(projectRoot, schemaRoot, embedded);
  if (loaded.binding === null) return loaded.issues;
  return [...loaded.issues, ...checkTrackerSecret(projectRoot, loaded.binding)];
}
