/**
 * The unattended lifecycle policy (docs/decisions/0014-unattended-lifecycle-policy.md): selection, and the
 * live, read-only forge evaluations ship rests on.
 *
 * A runner opts in through `AK_LIFECYCLE_POLICY=unattended` or `ak.lifecycle.json` on the default branch.
 * Phases then start with no typed command or grant, and the trust boundary moves to the merge: before ship
 * succeeds this module reads the target repository and refuses unless its default branch makes a
 * designated human reviewer's approval, app-pinned CI and an independent review check enforced, with no
 * bypass. Final ship success also validates the posted review at the pull request's head.
 *
 * Every forge request is `gh api --method GET`. Classic branch protection and secret placement are read
 * with the operator's read credential (`AK_UNATTENDED_READ_TOKEN`), everything else with the runner's own.
 * These checks run with the task's privileges: they catch an unprotected or misconfigured target and
 * accidents, not a determined task on the same account. The forge enforces the merge gate either way.
 *
 * Bundled into `bin/ak-gate.mjs` with `gate.ts`, so it imports only `node:` built-ins.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const POLICY_ENV = "AK_LIFECYCLE_POLICY";
export const READ_TOKEN_ENV = "AK_UNATTENDED_READ_TOKEN";
export const CONFIG_FILE = "ak.lifecycle.json";
export const UNATTENDED = "unattended";
export const DISCLOSURE =
  "Unattended lifecycle policy: no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, and merge is the human gate: it requires approval by a designated human reviewer.";
/** What the forge reads cannot show, stated by ship-preflight and review-status whatever their outcome. */
export const RESIDUAL_ASSUMPTIONS =
  "Residual assumptions these reads cannot verify: designated reviewer accounts are operated by people and are not reachable by the runner through credentials outside the forge client, so a runner that shares the operator's OS account and credentials does not meet them; team membership is not verified; a fine-grained read credential is scoped read-only by the operator; and the runner's push credential is the active one.";
/** The app every GitHub Actions workflow posts check runs as, a task branch's own included. */
export const ACTIONS_APP_ID = 15368;
export const HUMAN_STARTED_PHASES = ["super-align", "super-bound", "super-ship"] as const;
export const MODEL_STARTED_PHASES = ["super-scout", "super-build", "super-verify", "super-review"] as const;

export interface Policy {
  name: typeof UNATTENDED;
  /** `environment`, or `default-branch:<revision>` the configuration was read at. */
  source: string;
}

/** A parsed JSON value: what the forge and the configuration file return. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

const kind = (v: Json | undefined) => Object.prototype.toString.call(v);
const isText = (v: Json | undefined): v is string => kind(v) === "[object String]";
const isNumber = (v: Json | undefined): v is number => kind(v) === "[object Number]";
const isObject = (v: Json | undefined): v is JsonObject => kind(v) === "[object Object]";
/** JSON.parse yields only JSON values; this names that for the type system, one level deep. */
const JSON_KINDS = new Set(["Null", "Boolean", "Number", "String", "Array", "Object"].map((k) => `[object ${k}]`));
const isJson = (value: unknown): value is Json => JSON_KINDS.has(Object.prototype.toString.call(value));
const field = (v: Json | undefined, key: string): Json | undefined => (isObject(v) ? v[key] : undefined);
const items = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const nonEmpty = (v: Json | undefined): string | undefined => (isText(v) && v.trim() !== "" ? v : undefined);
const texts = (v: Json | undefined): string[] => items(v).filter(isText);
const pinned = (v: Json | undefined): number | undefined =>
  isNumber(v) && Number.isInteger(v) && v > 0 ? v : undefined;
const parse = (source: string): Json | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  return isJson(value) ? value : undefined;
};
const decode = (content: Json | undefined): string | undefined =>
  isText(content) ? Buffer.from(content, "base64").toString("utf8") : undefined;
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const exec = (cmd: string, args: readonly string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
};

/**
 * The active policy: the environment first, else the default-branch configuration at the local
 * `refs/remotes/origin/HEAD`, never the working tree or the task branch. Undefined is the legacy policy.
 */
export function resolvePolicy(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; policy?: Policy } | { ok: false; reason: string } {
  const value = env[POLICY_ENV];
  if (value !== undefined && value !== "") {
    if (value !== UNATTENDED)
      return { ok: false, reason: `${POLICY_ENV} accepts only '${UNATTENDED}', not '${value}'` };
    return { ok: true, policy: { name: UNATTENDED, source: "environment" } };
  }
  const rev = exec("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"], project);
  const revision = rev.out.trim();
  if (rev.code !== 0 || revision === "") return { ok: true };
  const file = exec("git", ["show", `${revision}:${CONFIG_FILE}`], project);
  if (file.code !== 0 || field(parse(file.out), "policy") !== UNATTENDED) return { ok: true };
  return { ok: true, policy: { name: UNATTENDED, source: `default-branch:${revision}` } };
}

// ── the forge ────────────────────────────────────────────────────────────────

export interface ForgeResponse {
  status: number;
  headers: Record<string, string>;
  body: Json | undefined;
  text: string;
  /** `sha256:<hex>` of the body's raw bytes as the client returned them, before any decoding. */
  digest: string;
}
export type Forge = (path: string, options?: { token?: string; accept?: string }) => ForgeResponse;

export interface GateIo {
  forge: Forge;
  /** The logins the forge client stores for the host, or undefined when they cannot be listed. */
  accounts: () => string[] | undefined;
  readToken?: string;
}

/** `gh api --method GET -i`: the status line and headers, then the body. */
export function ghForge(): Forge {
  return (path, options = {}) => {
    const env = { ...process.env };
    if (options.token !== undefined) env.GH_TOKEN = options.token;
    const args = ["api", "--method", "GET", "-i"];
    if (options.accept !== undefined) args.push("-H", `Accept: ${options.accept}`);
    const raw = spawnSync("gh", [...args, path], { env, maxBuffer: 64 * 1024 * 1024 }).stdout ?? Buffer.alloc(0);
    // latin1 decodes one character per byte, so the match index is the body's byte offset.
    const split = /\r?\n\r?\n/.exec(raw.toString("latin1"));
    const head = (split === null ? raw : raw.subarray(0, split.index)).toString("utf8");
    const body = split === null ? Buffer.alloc(0) : raw.subarray(split.index + split[0].length);
    const bodyText = body.toString("utf8");
    const lines = head.split(/\r?\n/);
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
    const headers: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return { status, headers, body: parse(bodyText) ?? bodyText, text: bodyText, digest: sha256(body) };
  };
}

/** The forge client's stored accounts for github.com (`gh auth status`, a client query, not a REST request). */
export function ghAccounts(): string[] | undefined {
  const r = exec("gh", ["auth", "status", "--json", "hosts", "--hostname", "github.com"]);
  const hosts = field(parse(r.out), "hosts");
  if (!isObject(hosts)) return undefined;
  return items(hosts["github.com"]).flatMap((entry) => nonEmpty(field(entry, "login")) ?? []);
}

const GITHUB_REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** `owner/name` of the origin remote when it is a GitHub repository. */
export function resolveRepo(project: string): { ok: true; repo: string } | { ok: false; reason: string } {
  const url = exec("git", ["remote", "get-url", "origin"], project).out.trim();
  const match = GITHUB_REMOTE.exec(url);
  if (match === null)
    return {
      ok: false,
      reason: `origin ${url === "" ? "is not set" : `${url} is not a GitHub repository`}; the unattended policy supports GitHub only`,
    };
  return { ok: true, repo: `${match[1] ?? ""}/${match[2] ?? ""}` };
}

// ── configuration ────────────────────────────────────────────────────────────

export interface LifecycleConfig {
  policy: Json | undefined;
  humanReviewers: string[];
  check: string;
  environment: string;
  keySecret: string;
  reviewerModel: string;
  authorModels: string[];
  aliases: Map<string, string>;
}

const MODEL_ID = /^[^/\s]+\/\S+$/;
const norm = (id: string) => id.trim().toLowerCase();

/** A canonical `provider/model` identity: trimmed, lower-cased and mapped once through the operator's aliases. */
export function canonicalModel(id: string, aliases: ReadonlyMap<string, string>): string {
  const key = norm(id);
  const mapped = [...aliases.entries()].find(([alias]) => norm(alias) === key)?.[1];
  return mapped === undefined ? key : norm(mapped);
}

function readConfig(body: Json | undefined, failures: string[]): LifecycleConfig | undefined {
  const value = parse(decode(field(body, "content")) ?? "");
  if (!isObject(value)) {
    failures.push(`${CONFIG_FILE} on the default branch is missing or not JSON`);
    return undefined;
  }
  const review = field(value, "independent_review");
  const aliasesValue = field(review, "model_aliases");
  const config: LifecycleConfig = {
    policy: value.policy,
    humanReviewers: texts(value.human_reviewers),
    check: nonEmpty(field(review, "check")) ?? "",
    environment: nonEmpty(field(review, "environment")) ?? "",
    keySecret: nonEmpty(field(review, "key_secret")) ?? "",
    reviewerModel: nonEmpty(field(review, "reviewer_model")) ?? "",
    authorModels: texts(field(review, "author_models")),
    aliases: new Map(
      isObject(aliasesValue)
        ? Object.entries(aliasesValue).flatMap(([alias, target]) => (isText(target) ? [[alias, target] as const] : []))
        : [],
    ),
  };
  if (config.humanReviewers.length === 0) failures.push(`${CONFIG_FILE}: human_reviewers is empty`);
  for (const [key, v] of [
    ["independent_review.check", config.check],
    ["independent_review.environment", config.environment],
    ["independent_review.key_secret", config.keySecret],
    ["independent_review.reviewer_model", config.reviewerModel],
  ] as const)
    if (v === "") failures.push(`${CONFIG_FILE}: ${key} is missing`);
  if (config.authorModels.length === 0) failures.push(`${CONFIG_FILE}: independent_review.author_models is empty`);
  for (const id of [config.reviewerModel, ...config.authorModels, ...config.aliases.keys(), ...config.aliases.values()])
    if (id !== "" && !MODEL_ID.test(id.trim()))
      failures.push(`${CONFIG_FILE}: model identity '${id}' is not of the form provider/model`);
  return config;
}

// ── the merge gate ───────────────────────────────────────────────────────────

export interface MergeGate {
  failures: string[];
  notes: string[];
  defaultBranch?: string;
  /** The app the required independent review check is pinned to. */
  reviewAppId?: number;
  config?: LifecycleConfig;
}

interface Source {
  name: string;
  approvals: boolean;
  codeOwners: boolean;
  dismissStale: boolean;
  lastPush: boolean;
  checks: { context: string; app?: number }[];
}

type Get = (path: string, read?: boolean) => ForgeResponse;

const PER_PAGE = 100;

/** A paginated listing read whole, or `failure` saying why it is not. */
interface Listing {
  found: Json[];
  /** The last page's HTTP status. */
  status: number;
  failure?: string;
}

/**
 * Every item of a paginated listing, page by page until `total_count` is reached. `failure` says why the
 * listing is not whole: a page is unreadable or carries no `total_count`, or the pages ran short of it.
 */
function listAll(get: Get, path: string, key: string, read = false): Listing {
  const found: Json[] = [];
  for (let n = 1; ; n += 1) {
    const r = get(`${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${n}`, read);
    const total = field(r.body, "total_count");
    if (r.status !== 200) return { found, status: r.status, failure: `unreadable (HTTP ${r.status})` };
    if (!isNumber(total)) return { found, status: r.status, failure: "listed without a total_count" };
    const batch = items(field(r.body, key));
    found.push(...batch);
    if (found.length >= total) return { found, status: r.status };
    if (batch.length < PER_PAGE)
      return { found, status: r.status, failure: `incomplete (${found.length} of ${total} listed)` };
  }
}

const isDesignated = (config: LifecycleConfig, who: string) =>
  config.humanReviewers.some((reviewer) => norm(reviewer).replace(/^@/, "") === norm(who).replace(/^@/, ""));
const requiredChecks = (list: Json | undefined, appKey: string) =>
  items(list).flatMap((entry) => {
    const context = nonEmpty(field(entry, "context"));
    return context === undefined ? [] : [{ context, app: pinned(field(entry, appKey)) }];
  });
const names = (list: Json[]) => list.flatMap((entry) => nonEmpty(field(entry, "name")) ?? []);
const atLeastOne = (count: Json | undefined) => isNumber(count) && count >= 1;

/** Classic protection as a counted source, when nothing may bypass it. */
function classicSource(p: ForgeResponse, failures: string[]): Source | undefined {
  const reviews = field(p.body, "required_pull_request_reviews");
  const allowances = field(reviews, "bypass_pull_request_allowances");
  const bypassers = ["users", "teams", "apps"].flatMap((key) => items(field(allowances, key)));
  const admins = field(field(p.body, "enforce_admins"), "enabled") === true;
  if (!admins) failures.push("classic protection does not enforce its rules for admins, so admins may bypass it");
  if (bypassers.length > 0)
    failures.push(`classic protection lets ${bypassers.length} actor(s) bypass the pull-request rule`);
  if (!admins || bypassers.length > 0) return undefined;
  return {
    name: "classic protection",
    approvals: atLeastOne(field(reviews, "required_approving_review_count")),
    codeOwners: field(reviews, "require_code_owner_reviews") === true,
    dismissStale: field(reviews, "dismiss_stale_reviews") === true,
    lastPush: field(reviews, "require_last_push_approval") === true,
    checks: requiredChecks(field(field(p.body, "required_status_checks"), "checks"), "app_id"),
  };
}

/** The active rulesets as counted sources, when their bypass list is readable and empty. */
function rulesetSources(get: Get, repo: string, rules: Json | undefined, uncountable: string[]): Source[] {
  const byRuleset = new Map<number, Json[]>();
  for (const rule of items(rules)) {
    const id = pinned(field(rule, "ruleset_id"));
    const type = field(rule, "type");
    if (id === undefined || (type !== "pull_request" && type !== "required_status_checks")) continue;
    byRuleset.set(id, [...(byRuleset.get(id) ?? []), rule]);
  }
  const sources: Source[] = [];
  for (const [id, found] of byRuleset) {
    const actors = field(get(`repos/${repo}/rulesets/${id}`, true).body, "bypass_actors");
    if (!Array.isArray(actors) || actors.length > 0) {
      uncountable.push(`ruleset ${id} (its bypass list is ${Array.isArray(actors) ? "not empty" : "unreadable"})`);
      continue;
    }
    const params = (type: string) =>
      field(
        found.find((r) => field(r, "type") === type),
        "parameters",
      );
    const pr = params("pull_request");
    sources.push({
      name: `ruleset ${id}`,
      approvals: atLeastOne(field(pr, "required_approving_review_count")),
      codeOwners: field(pr, "require_code_owner_review") === true,
      dismissStale: field(pr, "dismiss_stale_reviews_on_push") === true,
      lastPush: field(pr, "require_last_push_approval") === true,
      checks: requiredChecks(field(params("required_status_checks"), "required_status_checks"), "integration_id"),
    });
  }
  return sources;
}

/** The app the review check is pinned to, or the reason it does not count. */
function reviewApp(
  checks: Source["checks"],
  reviewCheck: string,
  defaultBranch: string,
): { app: number } | { failure: string } {
  const review = checks.filter((c) => c.context === reviewCheck);
  const apps = [...new Set(review.flatMap((c) => (c.app === undefined ? [] : [c.app])))];
  const [app] = apps;
  if (review.length === 0) return { failure: `${reviewCheck} is not a required check on ${defaultBranch}` };
  if (app === undefined)
    return { failure: `${reviewCheck} is required from any source; it must be pinned to the review app` };
  if (apps.length > 1) return { failure: `${reviewCheck} is pinned to more than one app (${apps.join(", ")})` };
  if (app === ACTIONS_APP_ID)
    return {
      failure: `${reviewCheck} is pinned to GitHub Actions, which any workflow on a task branch posts as; pin it to a dedicated app`,
    };
  return { app };
}

/**
 * Reads the target's default branch and returns every unmet merge-gate item. `identity` adds the runner's
 * own checks (account, role, stored accounts), which only the runner can answer.
 */
export function checkMergeGate(
  io: GateIo,
  repo: string,
  opts: { identity: boolean; policySource?: string },
): MergeGate {
  const failures: string[] = [];
  const notes: string[] = [];
  const get: Get = (path, read = false) => io.forge(path, read ? { token: io.readToken } : {});
  const repository = get(`repos/${repo}`);
  const defaultBranch = nonEmpty(field(repository.body, "default_branch"));
  if (repository.status !== 200 || defaultBranch === undefined)
    return { failures: [`repos/${repo} is unreadable (HTTP ${repository.status})`], notes };
  const ownerType = nonEmpty(field(field(repository.body, "owner"), "type"));
  const branch = encodeURIComponent(defaultBranch);

  const sources: Source[] = [];
  if (io.readToken === undefined)
    failures.push(`${READ_TOKEN_ENV} is not set, so classic branch protection cannot be read`);
  else {
    const p = get(`repos/${repo}/branches/${branch}/protection`, true);
    const scopes = (p.headers["x-oauth-scopes"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const write = scopes.filter((s) => !s.startsWith("read:") && s !== "user:email");
    if (write.length > 0) failures.push(`${READ_TOKEN_ENV} is a classic token with write scope ${write.join(", ")}`);
    const message = nonEmpty(field(p.body, "message"));
    const classic = p.status === 200 ? classicSource(p, failures) : undefined;
    if (classic !== undefined) sources.push(classic);
    if (p.status !== 200 && !(p.status === 404 && message === "Branch not protected"))
      failures.push(
        `classic branch protection of ${defaultBranch} is unreadable (HTTP ${p.status}${message === undefined ? "" : `: ${message}`})`,
      );
  }

  const rules = get(`repos/${repo}/rules/branches/${branch}`);
  if (rules.status !== 200) failures.push(`the rules active on ${defaultBranch} are unreadable (HTTP ${rules.status})`);
  const uncountable: string[] = [];
  sources.push(...rulesetSources(get, repo, rules.body, uncountable));
  if (uncountable.length > 0) notes.push(`not counted: ${uncountable.join("; ")}`);
  const counted = sources.map((s) => s.name).join(", ") || "none";
  const skipped = uncountable.length > 0 ? `; not counted: ${uncountable.join("; ")}` : "";
  const unmet = (what: string) =>
    failures.push(`${what} is not required by a non-bypassable source (counted: ${counted}${skipped})`);
  if (!sources.some((s) => s.approvals)) unmet("a pull request with at least one approval");
  if (!sources.some((s) => s.codeOwners)) unmet("code-owner review");
  if (!sources.some((s) => s.dismissStale)) unmet("dismissing stale approvals on push");
  if (!sources.some((s) => s.lastPush)) unmet("approval of the most recent push by someone other than its pusher");

  const configResponse = get(`repos/${repo}/contents/${CONFIG_FILE}?ref=${branch}`);
  const config = configResponse.status === 200 ? readConfig(configResponse.body, failures) : undefined;
  if (configResponse.status !== 200)
    failures.push(`${CONFIG_FILE} is missing from ${defaultBranch} (HTTP ${configResponse.status})`);
  if (config !== undefined && opts.policySource?.startsWith("default-branch:") === true && config.policy !== UNATTENDED)
    failures.push(`${CONFIG_FILE} on ${defaultBranch} no longer names the unattended policy this run was opened under`);
  // The local default-branch ref a run was stamped from is the task's to repoint; the forge's branch is not.
  const stamped = /^default-branch:(.+)$/.exec(opts.policySource ?? "")?.[1];
  if (stamped !== undefined) {
    const tip = nonEmpty(field(field(get(`repos/${repo}/branches/${branch}`).body, "commit"), "sha"));
    const standing = tip === undefined ? undefined : compareShipped(io, repo, stamped, tip);
    const status = standing === undefined || "error" in standing ? "unreadable" : standing.status;
    if (status !== "identical" && status !== "ahead")
      failures.push(
        `the run was opened under ${CONFIG_FILE} read at ${stamped.slice(0, 12)}, which is not on ${defaultBranch} as the forge reads it (comparison: ${status})`,
      );
  }

  const reviewCheck = config?.check ?? "";
  const checks = sources.flatMap((s) => s.checks);
  if (!checks.some((c) => c.context !== reviewCheck && c.app !== undefined))
    unmet("required CI (a required status check, other than the review check, pinned to a specific app)");
  const pinnedReview = reviewCheck === "" ? undefined : reviewApp(checks, reviewCheck, defaultBranch);
  if (pinnedReview !== undefined && "failure" in pinnedReview) failures.push(pinnedReview.failure);
  if (config !== undefined) {
    checkOwners(get, repo, defaultBranch, config, failures);
    checkEnvironment(get, repo, defaultBranch, ownerType, config, failures);
    if (opts.identity) checkIdentity(io, get, repo, config, failures);
  }
  const reviewAppId = pinnedReview !== undefined && "app" in pinnedReview ? pinnedReview.app : undefined;
  return { failures, notes, defaultBranch, reviewAppId, config };
}

function checkOwners(get: Get, repo: string, defaultBranch: string, config: LifecycleConfig, failures: string[]): void {
  const branch = encodeURIComponent(defaultBranch);
  const owners = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
    .values()
    .map((path) => get(`repos/${repo}/contents/${path}?ref=${branch}`))
    .map((r) => (r.status === 200 ? decode(field(r.body, "content")) : undefined))
    .find((text) => text !== undefined);
  if (owners === undefined) failures.push(`no code-owners file is readable on ${defaultBranch}`);
  else {
    const lines = owners
      .split("\n")
      .map((line) => line.replace(/(^|\s)#.*$/, "").trim())
      .filter((line) => line !== "")
      .map((line) => line.split(/\s+/));
    if (!lines.some(([pattern, ...who]) => pattern === "*" && who.length > 0))
      failures.push("the code-owners file has no catch-all rule (`*`) with owners");
    for (const [pattern, ...who] of lines) {
      if (who.length === 0) failures.push(`the code-owners rule '${pattern ?? ""}' is without owners`);
      for (const owner of who)
        if (!isDesignated(config, owner)) failures.push(`code owner ${owner} is not a designated human reviewer`);
    }
  }
  const errors = get(`repos/${repo}/codeowners/errors?ref=${branch}`);
  const found = items(field(errors.body, "errors"));
  if (errors.status !== 200)
    failures.push(`the code-owners errors for ${defaultBranch} are unreadable (HTTP ${errors.status})`);
  else if (found.length > 0) failures.push(`the forge reports ${found.length} code-owners errors on ${defaultBranch}`);
}

function checkEnvironment(
  get: Get,
  repo: string,
  defaultBranch: string,
  ownerType: string | undefined,
  config: LifecycleConfig,
  failures: string[],
): void {
  if (config.environment === "") return;
  const env = encodeURIComponent(config.environment);
  const policy = field(get(`repos/${repo}/environments/${env}`).body, "deployment_branch_policy");
  const branches = items(
    field(get(`repos/${repo}/environments/${env}/deployment-branch-policies`).body, "branch_policies"),
  );
  const [only] = branches;
  const policyType = field(only, "type");
  if (
    field(policy, "custom_branch_policies") !== true ||
    field(policy, "protected_branches") === true ||
    branches.length !== 1 ||
    field(only, "name") !== defaultBranch ||
    (policyType !== undefined && policyType !== "branch")
  )
    failures.push(
      `environment ${config.environment}'s deployment branch policy is not exactly the branch ${defaultBranch}`,
    );
  if (config.keySecret === "") return;
  const placed = (where: string, path: string, missingOk = false) => {
    const listing = listAll(get, path, "secrets", true);
    if (missingOk && listing.status === 404 && listing.found.length === 0) return;
    if (listing.failure !== undefined) failures.push(`${where} secrets are ${listing.failure}`);
    if (names(listing.found).includes(config.keySecret))
      failures.push(`${config.keySecret} is also stored as ${where} secret`);
  };
  placed("a repository", `repos/${repo}/actions/secrets`);
  placed("an organisation", `repos/${repo}/actions/organization-secrets`, ownerType === "User");
  const environments = listAll(get, `repos/${repo}/environments`, "environments");
  if (environments.failure !== undefined) failures.push(`the environments are ${environments.failure}`);
  for (const other of names(environments.found))
    if (other !== config.environment)
      placed(`the ${other} environment's`, `repos/${repo}/environments/${encodeURIComponent(other)}/secrets`);
}

function checkIdentity(io: GateIo, get: Get, repo: string, config: LifecycleConfig, failures: string[]): void {
  const user = get("user");
  const login = nonEmpty(field(user.body, "login"));
  if (user.status !== 200 || login === undefined || field(user.body, "type") !== "User")
    failures.push("the runner's forge credential is not a user account, so its identity cannot be checked");
  else {
    const role = nonEmpty(
      field(get(`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`).body, "role_name"),
    );
    if (role !== "write")
      failures.push(`the runner ${login} has role ${role ?? "unknown"} on ${repo}; it must be exactly write`);
    if (isDesignated(config, login)) failures.push(`the runner ${login} is a designated human reviewer`);
  }
  const stored = io.accounts();
  if (stored === undefined) failures.push("the forge client's stored accounts cannot be listed");
  else
    for (const account of stored)
      if (isDesignated(config, account)) failures.push(`stored account ${account} is a designated human reviewer`);
}

// ── the independent review ───────────────────────────────────────────────────

export interface ReviewStatus {
  state: "pass" | "waiting" | "refused";
  failures: string[];
  notes: string[];
  head?: string;
}

/** Removes HTML comments, which a pull request's rendered text does not show. */
export const visibleText = (body: string): string => body.replaceAll(/<!--[\s\S]*?-->/g, "");

const appOf = (run: Json) => field(field(run, "app"), "id");
const completedAt = (run: Json) => nonEmpty(field(run, "completed_at")) ?? "";

/** The stamped reviewer identity must agree across its sources, be the configured reviewer and no author model. */
function identityFailures(reviewer: Json | undefined, config: LifecycleConfig): string[] {
  const sources = field(reviewer, "sources");
  const fromConfig = nonEmpty(field(sources, "configuration"));
  const fromNative = nonEmpty(field(sources, "native_metadata"));
  if (fromConfig === undefined || fromNative === undefined)
    return ["the stamped reviewer identity lacks its configuration or native metadata source"];
  const canon = (id: string) => canonicalModel(id, config.aliases);
  if (canon(fromConfig) !== canon(fromNative))
    return [`the reviewer's configuration (${fromConfig}) and native metadata (${fromNative}) disagree`];
  const identity = canon(fromNative);
  const out: string[] = [];
  if (identity !== canon(config.reviewerModel))
    out.push(`the reviewer ${identity} is not the configured reviewer_model`);
  if (config.authorModels.some((m) => canon(m) === identity)) out.push(`the reviewer ${identity} is an author model`);
  return out;
}

/** Validates the independent review posted on the pull request's current head. */
export function checkReviewStatus(io: GateIo, repo: string, pr: number, gate: MergeGate): ReviewStatus {
  const failures = [...gate.failures];
  const notes = [...gate.notes];
  const pull = io.forge(`repos/${repo}/pulls/${pr}`).body;
  const head = nonEmpty(field(field(pull, "head"), "sha"));
  const base = field(pull, "base");
  if (head === undefined)
    return { state: "refused", failures: [...failures, `pull request ${pr} is unreadable`], notes };
  if (field(base, "ref") !== gate.defaultBranch)
    failures.push(
      `pull request ${pr} targets ${nonEmpty(field(base, "ref")) ?? "an unknown base"}, not ${gate.defaultBranch ?? "the default branch"}`,
    );
  if (!visibleText(nonEmpty(field(pull, "body")) ?? "").includes(DISCLOSURE))
    failures.push(`pull request ${pr}'s text does not carry the unattended disclosure outside HTML comments`);
  const { config, reviewAppId: app } = gate;
  if (config === undefined || app === undefined) return { state: "refused", failures, notes, head };

  const listing = listAll(
    (path) => io.forge(path),
    `repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(config.check)}&filter=all`,
    "check_runs",
  );
  if (listing.failure !== undefined)
    return {
      state: "refused",
      failures: [...failures, `the ${config.check} check runs are ${listing.failure}`],
      notes,
      head,
    };
  const runs = listing.found;
  const others = [...new Set(runs.filter((r) => appOf(r) !== app).map((r) => pinned(appOf(r)) ?? "unknown"))];
  if (others.length > 0) notes.push(`ignored ${config.check} run(s) from other apps: ${others.join(", ")}`);
  const completed = runs
    .filter((r) => appOf(r) === app && field(r, "status") === "completed")
    .toSorted((x, y) => completedAt(x).localeCompare(completedAt(y)));
  const latest = completed.at(-1);
  if (latest === undefined) return { state: failures.length > 0 ? "refused" : "waiting", failures, notes, head };
  const results = completed.map((r) => parse(nonEmpty(field(field(r, "output"), "text")) ?? ""));
  if (results.slice(0, -1).some((r) => field(r, "verdict") !== "approve"))
    failures.push(`an earlier ${config.check} run on ${head.slice(0, 12)} did not approve`);
  const result = results.at(-1);
  const conclusion = nonEmpty(field(latest, "conclusion")) ?? "unknown";
  if (conclusion !== "success") failures.push(`the latest ${config.check} run concluded ${conclusion}`);
  if (field(result, "schema") !== "independent-review")
    return {
      state: "refused",
      failures: [...failures, "the latest run carries no independent-review result"],
      notes,
      head,
    };
  const claimed = (key: string) => nonEmpty(field(result, key)) ?? "nothing";
  if (field(result, "head_sha") !== head) failures.push(`the review is for head ${claimed("head_sha")}, not ${head}`);
  if (field(result, "input") !== "diff-only") failures.push(`the review input is ${claimed("input")}, not diff-only`);
  if (field(result, "verdict") !== "approve") failures.push(`the review verdict is ${claimed("verdict")}`);
  const baseSha = nonEmpty(field(base, "sha")) ?? "";
  const diff = io.forge(`repos/${repo}/compare/${baseSha}...${head}`, { accept: "application/vnd.github.diff" });
  if (diff.status !== 200) failures.push(`the comparison diff is unreadable (HTTP ${diff.status})`);
  else if (field(result, "diff_sha256") !== diff.digest)
    failures.push(`the review's diff digest ${claimed("diff_sha256")} is not ${diff.digest}`);
  failures.push(...identityFailures(field(result, "reviewer"), config));
  return { state: failures.length > 0 ? "refused" : "pass", failures, notes, head };
}

/** Where the shipped revision stands against the pull request's head, read from the forge. */
export function compareShipped(
  io: GateIo,
  repo: string,
  shipped: string,
  head: string,
): { status: string; commits: { sha: string; author: string }[] } | { error: string } {
  const r = io.forge(`repos/${repo}/compare/${shipped}...${head}`);
  const status = nonEmpty(field(r.body, "status"));
  if (r.status !== 200 || status === undefined)
    return { error: `the comparison ${shipped.slice(0, 12)}...${head.slice(0, 12)} is unreadable (HTTP ${r.status})` };
  return {
    status,
    commits: items(field(r.body, "commits")).map((c) => ({
      sha: nonEmpty(field(c, "sha")) ?? "unknown",
      author:
        nonEmpty(field(field(c, "author"), "login")) ??
        nonEmpty(field(field(field(c, "commit"), "author"), "name")) ??
        "unknown",
    })),
  };
}
