/**
 * The unattended lifecycle policy (docs/decisions/0014-unattended-lifecycle-policy.md): opt-in selection,
 * the phase start check, command evidence, the pre-ticket import, the pre-ship check, the live merge-gate
 * read before ship and the independent review before final ship success.
 *
 * Two seams. The evaluations run over an in-memory forge serving API response shapes; each shape below is
 * written from the GitHub REST documentation unless it says it was recorded live. The command runs through
 * `runCli` in temporary git repositories with a stub `gh` on the search path that serves the same shapes
 * and logs every request's method.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli.ts";
import { defaultEvidenceDir, readRecords, takeSnapshot, type Gate, type Snapshot } from "../../src/lifecycle/gate.ts";
import {
  ACTIONS_APP_ID,
  canonicalModel,
  checkMergeGate,
  checkReviewStatus,
  DISCLOSURE,
  type Forge,
  type GateIo,
  type Json,
  type JsonObject,
} from "../../src/lifecycle/unattended.ts";
import { artifactHash } from "../../src/util/hash.ts";
import { makeTree } from "../helpers/tree.ts";

setDefaultTimeout(60_000);

const REPO = "acme/widget";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REVIEW_APP = 4242;
const CHECK = "agent-kit/independent-review";
const DIFF = "diff --git a/x b/x\n+changed\n";
/** One page of a paginated listing, as the forge reads it. */
const page = (path: string, n = 1) => `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${n}`;
const RUNS_PATH = `repos/${REPO}/commits/${HEAD}/check-runs?check_name=${encodeURIComponent(CHECK)}&filter=all`;
const RUNS_KEY = page(RUNS_PATH);
const CONFIG_KEY = `repos/${REPO}/contents/ak.lifecycle.json?ref=main`;
const OWNERS_KEY = `repos/${REPO}/contents/.github/CODEOWNERS?ref=main`;
const PROTECTION_KEY = `repos/${REPO}/branches/main/protection`;
const REPO_SECRETS = `repos/${REPO}/actions/secrets`;
const sha = (text: string | Uint8Array) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

interface Fixture {
  status?: number;
  headers?: Record<string, string>;
  body?: Json;
  /** A raw body, served as is (the comparison diff). */
  text?: string;
  /** A raw body given as base64, for bytes that are not UTF-8. */
  base64?: string;
}
/** A listing page carrying its `total_count`, as the forge's paginated listings do. */
const listed = (key: string, list: Json[], total = list.length): Fixture => ({
  body: { total_count: total, [key]: list },
});
interface FixtureMap {
  [path: string]: Fixture;
}

const REVIEW = {
  check: CHECK,
  environment: "independent-review",
  key_secret: "REVIEW_APP_KEY",
  reviewer_model: "prov/model-b",
  author_models: ["prov/model-a"],
};
const CONFIG = { policy: "unattended", human_reviewers: ["@alice", "@acme/maintainers"], independent_review: REVIEW };
/** The residual assumptions ship-preflight and review-status state (AC-8), one phrase each. */
const RESIDUAL = [
  "designated reviewer accounts are operated by people",
  "not reachable by the runner through credentials outside the forge client",
  "team membership is not verified",
  "scoped read-only by the operator",
  "the runner's push credential is the active one",
];

function identity(configuration: string, native?: string): JsonObject {
  const sources: JsonObject = { configuration };
  if (native !== undefined) sources.native_metadata = native;
  return { model: configuration, sources };
}

function result(overrides: JsonObject = {}): JsonObject {
  return {
    schema: "independent-review",
    schema_version: 1,
    head_sha: HEAD,
    base_sha: BASE,
    diff_sha256: sha(DIFF),
    input: "diff-only",
    reviewer: identity("prov/model-b", "prov/model-b"),
    verdict: "approve",
    findings: [],
    ...overrides,
  };
}

/** A completion time `minute` minutes into the hour. */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 29, 1, minute)).toISOString();

function checkRun(id: number, body: JsonObject, overrides: JsonObject = {}): JsonObject {
  return {
    id,
    name: CHECK,
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
    completed_at: `2026-10-29T0${id}:00:00Z`,
    app: { id: REVIEW_APP },
    output: { text: JSON.stringify(body) },
    ...overrides,
  };
}

interface Classic {
  admins?: boolean;
  bypass?: Json[];
  codeOwners?: boolean;
  stale?: boolean;
  lastPush?: boolean;
  checks?: { context: string; app_id: number | null }[];
}

const DEFAULT_CHECKS = [
  { context: "ci/test", app_id: ACTIONS_APP_ID },
  { context: CHECK, app_id: REVIEW_APP },
];

function classic(c: Classic = {}): JsonObject {
  return {
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      require_code_owner_reviews: c.codeOwners ?? true,
      dismiss_stale_reviews: c.stale ?? true,
      require_last_push_approval: c.lastPush ?? true,
      bypass_pull_request_allowances: { users: c.bypass ?? [], teams: [], apps: [] },
    },
    required_status_checks: { strict: true, checks: c.checks ?? DEFAULT_CHECKS },
    enforce_admins: { enabled: c.admins ?? true },
  };
}

/** A repository whose default branch enforces every merge-gate item through classic protection. */
function protectedFixtures(): FixtureMap {
  return {
    [`repos/${REPO}`]: { body: { default_branch: "main", owner: { type: "Organization" } } },
    [PROTECTION_KEY]: { body: classic() },
    [`repos/${REPO}/rules/branches/main`]: { body: [] },
    [CONFIG_KEY]: { body: { content: b64(JSON.stringify(CONFIG)) } },
    [OWNERS_KEY]: { body: { content: b64("* @alice @acme/maintainers\n") } },
    [`repos/${REPO}/codeowners/errors?ref=main`]: { body: { errors: [] } },
    user: { body: { login: "runner-bot", type: "User" } },
    [`repos/${REPO}/collaborators/runner-bot/permission`]: { body: { permission: "write", role_name: "write" } },
    [`repos/${REPO}/environments/independent-review`]: {
      body: { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    },
    [`repos/${REPO}/environments/independent-review/deployment-branch-policies`]: {
      body: { branch_policies: [{ name: "main", type: "branch" }] },
    },
    [page(REPO_SECRETS)]: listed("secrets", []),
    [page(`repos/${REPO}/actions/organization-secrets`)]: listed("secrets", []),
    [page(`repos/${REPO}/environments`)]: listed("environments", [{ name: "independent-review" }, { name: "prod" }]),
    [page(`repos/${REPO}/environments/prod/secrets`)]: listed("secrets", [{ name: "DEPLOY_KEY" }]),
    [`repos/${REPO}/pulls/7`]: {
      body: { number: 7, base: { ref: "main", sha: BASE }, head: { sha: HEAD }, body: `Change.\n\n${DISCLOSURE}\n` },
    },
    [RUNS_KEY]: listed("check_runs", [checkRun(1, result())]),
    [`repos/${REPO}/compare/${BASE}...${HEAD}#diff`]: { text: DIFF },
  };
}

function withFixtures(changes: FixtureMap, removed: string[] = []): FixtureMap {
  const fixtures = { ...protectedFixtures(), ...changes };
  for (const key of removed) Reflect.deleteProperty(fixtures, key);
  return fixtures;
}

const UNPROTECTED: FixtureMap = { [PROTECTION_KEY]: { status: 404, body: { message: "Branch not protected" } } };
const configWith = (value: JsonObject): FixtureMap => ({
  [CONFIG_KEY]: { body: { content: b64(JSON.stringify(value)) } },
});
const runsWith = (list: Json[]): FixtureMap => ({ [RUNS_KEY]: listed("check_runs", list) });

function memForge(fixtures: FixtureMap, log: string[] = []): Forge {
  return (path, options = {}) => {
    const key = options.accept?.includes("diff") === true ? `${path}#diff` : path;
    log.push(`${options.token === undefined ? "runner" : "read"} ${key}`);
    const fixture = fixtures[key];
    const body: Json = fixture === undefined ? { message: "Not Found" } : (fixture.body ?? null);
    const text = fixture?.text ?? JSON.stringify(body);
    return {
      status: fixture === undefined ? 404 : (fixture.status ?? 200),
      headers: fixture?.headers ?? {},
      body,
      text,
      digest: sha(text),
    };
  };
}

function io(fixtures: FixtureMap, log: string[] = [], accounts = ["runner-bot"]): GateIo {
  return { forge: memForge(fixtures, log), accounts: () => accounts, readToken: "read-token" };
}

const failuresOf = (fixtures: FixtureMap, withIdentity = true) =>
  checkMergeGate(io(fixtures), REPO, { identity: withIdentity, policySource: "environment" }).failures.join("\n");

function reviewOf(fixtures: FixtureMap) {
  return checkReviewStatus(
    io(fixtures),
    REPO,
    7,
    checkMergeGate(io(fixtures), REPO, { identity: false, policySource: "environment" }),
  );
}

function aliased(target: string): FixtureMap {
  return {
    ...configWith({
      ...CONFIG,
      independent_review: { ...REVIEW, reviewer_model: "prov/latest", model_aliases: { "prov/latest": target } },
    }),
    ...runsWith([checkRun(1, result({ reviewer: identity("prov/latest", target) }))]),
  };
}

const scoped = (scopes: string) =>
  withFixtures({ [PROTECTION_KEY]: { body: classic(), headers: { "x-oauth-scopes": scopes } } });

describe("merge gate (pure, API shapes written from the documentation)", () => {
  test("a fully protected default branch passes, reads protection and secrets with the read credential only", () => {
    const log: string[] = [];
    const r = checkMergeGate(io(protectedFixtures(), log), REPO, { identity: true, policySource: "environment" });
    expect(r.failures).toEqual([]);
    expect(r.reviewAppId).toBe(REVIEW_APP);
    expect(log.flatMap((line) => (line.startsWith("read ") ? [line.slice(5)] : [])).toSorted()).toEqual(
      [
        page(`repos/${REPO}/actions/organization-secrets`),
        page(REPO_SECRETS),
        PROTECTION_KEY,
        page(`repos/${REPO}/environments/prod/secrets`),
      ].toSorted(),
    );
    expect(log).toContain("runner user");
  });

  test("the live unprotected shape (recorded from Pibomeister/agent-kit main, 2026-10-29) refuses every item", () => {
    const failures = failuresOf(withFixtures(UNPROTECTED));
    for (const item of ["approval", "code-owner", "stale", "most recent push", "required CI", CHECK])
      expect(failures).toContain(item);
  });

  test("an unreadable protection response and a missing read credential refuse as unknown", () => {
    expect(failuresOf(withFixtures({ [PROTECTION_KEY]: { status: 404, body: { message: "Not Found" } } }))).toContain(
      "unreadable",
    );
    const missing = checkMergeGate({ ...io(protectedFixtures()), readToken: undefined }, REPO, {
      identity: true,
      policySource: "environment",
    });
    expect(missing.failures.join("\n")).toContain("AK_UNATTENDED_READ_TOKEN");
  });

  test.each([
    ["admins may bypass", { admins: false }, "admins"],
    ["a pull-request bypass allowance", { bypass: [{ login: "bot" }] }, "bypass"],
    ["no code-owner review", { codeOwners: false }, "code-owner"],
    ["stale approvals kept", { stale: false }, "stale"],
    ["no last-push approval", { lastPush: false }, "most recent push"],
  ])("%s refuses", (_name, change: Classic, word) => {
    expect(failuresOf(withFixtures({ [PROTECTION_KEY]: { body: classic(change) } }))).toContain(word);
  });

  test("a required check from any source does not count, and a review check pinned to GitHub Actions refuses", () => {
    const anySource = failuresOf(
      withFixtures({
        [PROTECTION_KEY]: {
          body: classic({
            checks: [
              { context: "ci/test", app_id: null },
              { context: CHECK, app_id: null },
            ],
          }),
        },
      }),
    );
    expect(anySource).toContain("required CI");
    expect(anySource).toContain(CHECK);
    const actionsPinned = [
      { context: "ci/test", app_id: ACTIONS_APP_ID },
      { context: CHECK, app_id: ACTIONS_APP_ID },
    ];
    expect(failuresOf(withFixtures({ [PROTECTION_KEY]: { body: classic({ checks: actionsPinned }) } }))).toContain(
      "GitHub Actions",
    );
    const notRequired = [{ context: "ci/test", app_id: ACTIONS_APP_ID }];
    expect(failuresOf(withFixtures({ [PROTECTION_KEY]: { body: classic({ checks: notRequired }) } }))).toContain(
      `${CHECK} is not a required check`,
    );
  });

  test("a ruleset counts only with a readable empty bypass list, and an uncountable one does not block classic", () => {
    const partial = withFixtures({
      [`repos/${REPO}/rules/branches/main`]: {
        body: [{ type: "pull_request", ruleset_id: 9, parameters: { required_approving_review_count: 1 } }],
      },
      [`repos/${REPO}/rulesets/9`]: { body: { id: 9, enforcement: "active" } },
    });
    expect(failuresOf(partial)).toBe("");
    const rules: Fixture = {
      body: [
        {
          type: "pull_request",
          ruleset_id: 9,
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
            require_last_push_approval: true,
          },
        },
        {
          type: "required_status_checks",
          ruleset_id: 9,
          parameters: {
            required_status_checks: [
              { context: "ci/test", integration_id: ACTIONS_APP_ID },
              { context: CHECK, integration_id: REVIEW_APP },
            ],
          },
        },
      ],
    };
    const hidden = { body: { id: 9, enforcement: "active" } };
    const empty = { body: { id: 9, enforcement: "active", bypass_actors: [] } };
    const base = { ...UNPROTECTED, [`repos/${REPO}/rules/branches/main`]: rules };
    expect(failuresOf(withFixtures({ ...base, [`repos/${REPO}/rulesets/9`]: hidden }))).toContain("bypass list");
    expect(failuresOf(withFixtures({ ...base, [`repos/${REPO}/rulesets/9`]: empty }))).toBe("");
    const forbidden = { status: 403, body: { message: "Forbidden", bypass_actors: [] } };
    expect(failuresOf(withFixtures({ ...base, [`repos/${REPO}/rulesets/9`]: forbidden }))).toContain(
      "ruleset 9 (its detail is unreadable (HTTP 403))",
    );
  });

  test("code owners: catch-all, owners inside the designated set, no ownerless rule and no forge errors", () => {
    const owners = (text: string) => withFixtures({ [OWNERS_KEY]: { body: { content: b64(text) } } });
    expect(failuresOf(owners("src/ @alice\n"))).toContain("catch-all");
    expect(failuresOf(owners("* @alice @mallory\n"))).toContain("@mallory");
    expect(failuresOf(owners("* @alice\ndocs/\n"))).toContain("without owners");
    const errors = { body: { errors: [{ line: 1, kind: "Unknown owner", message: "Unknown owner" }] } };
    expect(failuresOf(withFixtures({ [`repos/${REPO}/codeowners/errors?ref=main`]: errors }))).toContain(
      "code-owners errors",
    );
    const docs = { [`repos/${REPO}/contents/docs/CODEOWNERS?ref=main`]: { body: { content: b64("* @alice\n") } } };
    expect(failuresOf(withFixtures(docs, [OWNERS_KEY]))).toBe("");
  });

  test("configuration comes from the default branch and must name reviewers, models and the policy", () => {
    expect(failuresOf(withFixtures(configWith({ ...CONFIG, human_reviewers: [] })))).toContain("human_reviewers");
    const noAuthors = configWith({ ...CONFIG, independent_review: { ...REVIEW, author_models: [] } });
    expect(failuresOf(withFixtures(noAuthors))).toContain("author_models");
    const bare = configWith({ ...CONFIG, independent_review: { ...REVIEW, reviewer_model: "model-b" } });
    expect(failuresOf(withFixtures(bare))).toContain("provider/model");
    const notPolicy = withFixtures(configWith({ ...CONFIG, policy: "legacy" }));
    const fromRepo = checkMergeGate(io(notPolicy), REPO, { identity: true, policySource: "default-branch:abc" });
    expect(fromRepo.failures.join("\n")).toContain("no longer names the unattended policy");
    expect(failuresOf(notPolicy)).toBe("");
  });

  test("the runner must be a non-admin, non-designated user account, and no stored account may be designated", () => {
    const admin = withFixtures({
      [`repos/${REPO}/collaborators/runner-bot/permission`]: { body: { permission: "admin", role_name: "admin" } },
    });
    expect(failuresOf(admin)).toContain("role");
    expect(failuresOf(admin, false)).toBe("");
    expect(
      failuresOf(withFixtures({ user: { status: 403, body: { message: "Resource not accessible by integration" } } })),
    ).toContain("user account");
    const designated = withFixtures({
      user: { body: { login: "alice", type: "User" } },
      [`repos/${REPO}/collaborators/alice/permission`]: { body: { permission: "write", role_name: "write" } },
    });
    expect(failuresOf(designated)).toContain("designated");
    const stored = checkMergeGate(io(protectedFixtures(), [], ["runner-bot", "Alice"]), REPO, {
      identity: true,
      policySource: "environment",
    });
    expect(stored.failures.join("\n")).toContain("stored");
  });

  test("an environment, branch-policy or permission read that is not HTTP 200 refuses, though its body would pass", () => {
    const fixtures = protectedFixtures();
    expect(failuresOf(fixtures)).toBe("");
    const forbidden = (key: string) => withFixtures({ [key]: { ...fixtures[key], status: 403 } });
    const environment = `repos/${REPO}/environments/independent-review`;
    expect(failuresOf(forbidden(environment))).toContain("environment independent-review is unreadable (HTTP 403)");
    expect(failuresOf(forbidden(`${environment}/deployment-branch-policies`))).toContain(
      "environment independent-review's deployment branch policies are unreadable (HTTP 403)",
    );
    expect(failuresOf(forbidden(`repos/${REPO}/collaborators/runner-bot/permission`))).toContain(
      `the runner runner-bot's role on ${REPO} is unreadable (HTTP 403)`,
    );
  });

  test("a classic read credential with a write scope refuses", () => {
    expect(failuresOf(scoped("read:org, repo"))).toContain("write scope");
    expect(failuresOf(scoped("read:org"))).toBe("");
  });

  test("the review key's environment is the default branch only and the key is stored nowhere else", () => {
    const wildcard = {
      [`repos/${REPO}/environments/independent-review/deployment-branch-policies`]: {
        body: { branch_policies: [{ name: "*", type: "branch" }] },
      },
    };
    expect(failuresOf(withFixtures(wildcard))).toContain("deployment branch policy");
    const keyed = listed("secrets", [{ name: "REVIEW_APP_KEY" }]);
    expect(failuresOf(withFixtures({ [page(REPO_SECRETS)]: keyed }))).toContain("REVIEW_APP_KEY");
    expect(failuresOf(withFixtures({ [page(`repos/${REPO}/environments/prod/secrets`)]: keyed }))).toContain("prod");
  });

  test("every page of a secrets listing is read: the key on page two refuses, a short listing refuses", () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ name: `SECRET_${i}` }));
    const twoPages = withFixtures({
      [page(REPO_SECRETS)]: listed("secrets", filler, 101),
      [page(REPO_SECRETS, 2)]: listed("secrets", [{ name: "REVIEW_APP_KEY" }], 101),
    });
    expect(failuresOf(twoPages)).toContain("REVIEW_APP_KEY is also stored as a repository secret");
    const clean = withFixtures({
      [page(REPO_SECRETS)]: listed("secrets", filler, 101),
      [page(REPO_SECRETS, 2)]: listed("secrets", [{ name: "OTHER" }], 101),
    });
    expect(failuresOf(clean)).toBe("");
    const short = withFixtures({ [page(REPO_SECRETS)]: listed("secrets", [{ name: "OTHER" }], 3) });
    expect(failuresOf(short)).toContain("repository secrets are incomplete (1 of 3 listed)");
    const unreadable = withFixtures({
      [page(REPO_SECRETS)]: listed("secrets", filler, 101),
      [page(REPO_SECRETS, 2)]: { status: 502, body: { message: "Bad Gateway" } },
    });
    expect(failuresOf(unreadable)).toContain("repository secrets are unreadable (HTTP 502)");
  });

  test("a repository-sourced run must have been stamped from a revision on the forge's default branch", () => {
    const stamped = "c".repeat(40);
    const tip = "d".repeat(40);
    const branchKey = `repos/${REPO}/branches/main`;
    const standing = (status?: string): FixtureMap => {
      const fixtures = withFixtures({ [branchKey]: { body: { name: "main", commit: { sha: tip } } } });
      if (status !== undefined) fixtures[`repos/${REPO}/compare/${stamped}...${tip}`] = { body: { status } };
      return fixtures;
    };
    const failuresAt = (fixtures: FixtureMap, source = `default-branch:${stamped}`) =>
      checkMergeGate(io(fixtures), REPO, { identity: true, policySource: source }).failures.join("\n");
    expect(failuresAt(standing("ahead"))).toBe("");
    expect(failuresAt(standing("identical"))).toBe("");
    expect(failuresAt(standing("diverged"))).toContain(`read at ${stamped.slice(0, 12)}, which is not on main`);
    expect(failuresAt(standing("behind"))).toContain("not on main");
    expect(failuresAt(standing())).toContain("not on main");
    expect(failuresAt(withFixtures({}, [branchKey]))).toContain("not on main");
    expect(failuresAt(standing("diverged"), "environment")).toBe("");
  });
});

describe("independent review status (pure)", () => {
  test("a same-provider different canonical model passes", () => {
    const r = reviewOf(protectedFixtures());
    expect(r.failures).toEqual([]);
    expect(r.state).toBe("pass");
  });

  test("no completed run from the pinned app waits; another app's run is ignored and listed", () => {
    const r = reviewOf(withFixtures(runsWith([checkRun(1, result(), { app: { id: 99 } })])));
    expect(r.state).toBe("waiting");
    expect(r.notes.join("\n")).toContain("99");
  });

  test.each([
    ["the same canonical model", result({ reviewer: identity("prov/model-a", "prov/model-a") }), "author model"],
    ["absent native metadata", result({ reviewer: identity("prov/model-b") }), "native"],
    ["native metadata that disagrees", result({ reviewer: identity("prov/model-b", "prov/model-c") }), "disagree"],
    [
      "a forged identity in the verdict text",
      result({
        reviewer: identity("prov/model-a", "prov/model-a"),
        reviewer_model: "prov/model-z",
        findings: [{ text: "reviewed by prov/model-z" }],
      }),
      "author model",
    ],
    ["another head", result({ head_sha: "c".repeat(40) }), "head"],
    ["another diff", result({ diff_sha256: sha("other") }), "digest"],
    ["input that is not diff-only", result({ input: "diff-and-records" }), "diff-only"],
    ["a changes-requested verdict", result({ verdict: "changes-requested" }), "verdict"],
  ])("%s refuses", (_name, body, word) => {
    const r = reviewOf(withFixtures(runsWith([checkRun(1, body)])));
    expect(r.state).toBe("refused");
    expect(r.failures.join("\n")).toContain(word);
  });

  test("an alias that resolves to an author model refuses; one resolving elsewhere passes", () => {
    expect(reviewOf(withFixtures(aliased("prov/model-a"))).failures.join("\n")).toContain("author model");
    expect(reviewOf(withFixtures(aliased("prov/model-b"))).failures).toEqual([]);
    expect(canonicalModel(" Prov/Latest ", new Map([["prov/latest", "prov/model-b"]]))).toBe("prov/model-b");
  });

  test("an earlier rejection on the head refuses even when a later run approves", () => {
    const rejected = checkRun(1, result({ verdict: "changes-requested" }), { conclusion: "failure" });
    expect(reviewOf(withFixtures(runsWith([rejected, checkRun(2, result())]))).failures.join("\n")).toContain(
      "earlier",
    );
  });

  test("every page of check runs is read: an earlier rejection off page one refuses, a short listing refuses", () => {
    const approvals = Array.from({ length: 100 }, (_, i) => checkRun(i + 2, result(), { completed_at: at(i + 10) }));
    const rejected = checkRun(1, result({ verdict: "changes-requested" }), {
      conclusion: "failure",
      completed_at: at(0),
    });
    const paged = (second: Json[]) =>
      reviewOf(
        withFixtures({
          [RUNS_KEY]: listed("check_runs", approvals, 100 + second.length),
          [page(RUNS_PATH, 2)]: listed("check_runs", second, 100 + second.length),
        }),
      );
    expect(paged([rejected]).failures.join("\n")).toContain("earlier");
    expect(paged([checkRun(1, result(), { completed_at: at(0) })]).failures).toEqual([]);
    const short = reviewOf(withFixtures({ [RUNS_KEY]: listed("check_runs", [checkRun(1, result())], 4) }));
    expect(short.state).toBe("refused");
    expect(short.failures.join("\n")).toContain("check runs are incomplete (1 of 4 listed)");
  });

  test("the pull request text must carry the disclosure outside HTML comments", () => {
    const hidden = {
      [`repos/${REPO}/pulls/7`]: {
        body: { base: { ref: "main", sha: BASE }, head: { sha: HEAD }, body: `<!-- ${DISCLOSURE} -->` },
      },
    };
    expect(reviewOf(withFixtures(hidden)).failures.join("\n")).toContain("disclosure");
  });
});

// ── the command seam ─────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function repo(): string {
  const dir = realpathSync(makeTree({ "src/a.js": "export const a = 1;\n" }));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  git(dir, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  return dir;
}

function ak(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(["lifecycle", ...argv], { cwd, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const saved = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  saved.clear();
});
beforeEach(() => setEnv({ AK_LIFECYCLE_POLICY: undefined, AK_UNATTENDED_READ_TOKEN: undefined }));

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = __dirname;
const { fixtures, accounts } = JSON.parse(fs.readFileSync(dir + "/fixtures.json", "utf8"));
const args = process.argv.slice(2);
if (args[0] === "auth") {
  fs.appendFileSync(dir + "/log", "CLIENT auth status\\n");
  process.stdout.write(JSON.stringify({ hosts: { "github.com": accounts.map((login) => ({ login })) } }));
  process.exit(0);
}
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "IMPLICIT";
const accept = args.find((a) => a.startsWith("Accept:")) || "";
const path = args[args.length - 1];
fs.appendFileSync(dir + "/log", method + " " + path + " " + (process.env.GH_TOKEN ? "read" : "runner") + "\\n");
const f = fixtures[accept.includes("diff") ? path + "#diff" : path];
const status = f ? (f.status || 200) : 404;
const text = f ? (f.text !== undefined ? f.text : JSON.stringify(f.body === undefined ? null : f.body)) : '{"message":"Not Found"}';
const raw = f && f.base64 !== undefined ? Buffer.from(f.base64, "base64") : Buffer.from(text);
const headers = Object.entries((f && f.headers) || {}).map(([k, v]) => k + ": " + v + "\\r\\n").join("");
process.stdout.write(Buffer.concat([Buffer.from("HTTP/2.0 " + status + " X\\r\\n" + headers + "\\r\\n"), raw]));
process.exit(status < 300 ? 0 : 1);
`;

/** A stub `gh` on the search path: serves `fixtures` by request path and logs each request's method. */
function stubGh(fixtures: FixtureMap, accounts = ["runner-bot"]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-gh-stub-")));
  writeFileSync(join(dir, "fixtures.json"), JSON.stringify({ fixtures, accounts }));
  writeFileSync(join(dir, "gh"), STUB);
  chmodSync(join(dir, "gh"), 0o755);
  setEnv({ PATH: `${dir}:${process.env.PATH ?? ""}`, GH_TOKEN: undefined });
  return () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n") : []);
}

function ticketFile(cwd: string): string {
  const path = join(cwd, "ticket.json");
  const ticket = {
    schema: "ticket",
    schema_version: 1,
    id: "demo-ticket",
    acceptance_criteria: [{ id: "AC-1", text: "The behavior is verified." }],
    verification: [{ id: "project-check", check: "Run the project check.", kind: "command", supports: ["AC-1"] }],
  };
  writeFileSync(path, `${JSON.stringify(ticket)}\n`);
  return path;
}

const isSnapshot = (s: Snapshot | string): s is Snapshot => Object(s) === s;
function snapshotOf(cwd: string): Snapshot {
  const s = takeSnapshot(cwd);
  if (!isSnapshot(s)) throw new Error(s);
  return s;
}

function receiptFile(cwd: string, run: string, ticketPath: string, extra: JsonObject = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-receipt-")));
  writeFileSync(join(dir, "out.log"), "1 pass\n");
  const digest = sha("1 pass\n");
  const ticket: unknown = JSON.parse(readFileSync(ticketPath, "utf8"));
  const doc = {
    schema: "verification",
    schema_version: 1,
    id: `verification-${Math.random().toString(16).slice(2)}`,
    project: { id: "demo" },
    run_id: run,
    created_by: { role: "runner" },
    inputs: [],
    source_revision: snapshotOf(cwd),
    created_at: "2026-10-29T00:00:00Z",
    status: "passed",
    kind: "command",
    command: { argv: ["bun", "test"] },
    exit_status: 0,
    output_digest: digest,
    artifacts: [{ path: "out.log", digest, kind: "log" }],
    environment: { id: "test", isolated: true, secrets_policy: "none" },
    supports: ["AC-1"],
    check: "project-check",
    ticket: { id: "demo-ticket", schema: "ticket", hash: artifactHash(ticket) },
    ...extra,
  };
  const path = join(dir, "receipt.json");
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const ok = ["sh", "-c", "echo ok"];
const store = (cwd: string) => defaultEvidenceDir(cwd);
const recordsOf = (cwd: string, run: string, gate: Gate) => readRecords(store(cwd), run, gate);
function runId(out: string): string {
  const id = /opened run (\S+)/.exec(out)?.[1];
  if (id === undefined) throw new Error(`open printed no run: ${out}`);
  return id;
}

/** An opened unattended run with every phase gate before ship recorded with a passing command. */
function fullRun(cwd: string): string {
  for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const ticketPath = ticketFile(cwd);
  const opened = ak(cwd, "open", "--ticket", ticketPath);
  expect(opened.code).toBe(0);
  const run = runId(opened.out);
  for (const g of ["build-checks", "review-full", "review-readiness"])
    expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  expect(ak(cwd, "record", "--gate", "verify", "--receipt", receiptFile(cwd, run, ticketPath), "--", ...ok).code).toBe(
    0,
  );
  return run;
}

/** An opened unattended run whose full review requested changes, current through a review-delta running `delta`. */
function deltaRun(cwd: string, delta: string[]) {
  const ticketPath = ticketFile(cwd);
  for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
  const run = runId(ak(cwd, "open", "--ticket", ticketPath).out);
  expect(ak(cwd, "record", "--gate", "build-checks", "--", ...ok).code).toBe(0);
  expect(ak(cwd, "record", "--gate", "review-full", "--verdict", "changes-requested", "--", ...ok).code).toBe(0);
  const code = ak(cwd, "record", "--gate", "review-delta", "--", ...delta).code;
  expect(ak(cwd, "record", "--gate", "review-readiness", "--", ...ok).code).toBe(0);
  expect(ak(cwd, "record", "--gate", "verify", "--receipt", receiptFile(cwd, run, ticketPath), "--", ...ok).code).toBe(
    0,
  );
  return { run, code };
}

/** The one record file of a gate in a run. */
function recordFile(cwd: string, run: string, gate: Gate): string {
  const dir = join(store(cwd), run, gate);
  const [name] = readdirSync(dir).filter((file) => file.endsWith(".json"));
  if (name === undefined) throw new Error(`no ${gate} record in ${dir}`);
  return join(dir, name);
}

describe("selection and start (command seam)", () => {
  test("legacy by default: a human-started phase needs its typed command, a model-started one starts, nothing names the opt-in", () => {
    const cwd = repo();
    const align = ak(cwd, "unattended", "check", "--phase", "super-align");
    expect(align.code).toBe(1);
    expect(align.err).toContain("typed command");
    expect(align.err).not.toContain("AK_LIFECYCLE_POLICY");
    expect(align.err).not.toContain("ak.lifecycle.json");
    expect(ak(cwd, "unattended", "check", "--phase", "super-scout").code).toBe(0);
    expect(ak(cwd, "unattended", "check", "--phase", "super-merge").code).toBe(2);
  });

  test("the environment selects it; another value is refused with exit 2", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const r = ak(cwd, "unattended", "check", "--phase", "super-ship");
    expect(r.code).toBe(0);
    const printed: unknown = JSON.parse(r.out);
    expect(printed).toMatchObject({ policy: "unattended", source: "environment", phase: "super-ship" });
    setEnv({ AK_LIFECYCLE_POLICY: "unatended" });
    expect(ak(cwd, "unattended", "check", "--phase", "super-ship").code).toBe(2);
  });

  test("the default-branch configuration selects it; the same file only on the task branch does not", () => {
    const cwd = repo();
    writeFileSync(join(cwd, "ak.lifecycle.json"), JSON.stringify({ policy: "unattended" }));
    expect(ak(cwd, "unattended", "check", "--phase", "super-align").code).toBe(1);
    git(cwd, "checkout", "-q", "main");
    git(cwd, "add", "ak.lifecycle.json");
    git(cwd, "commit", "-q", "-m", "opt in");
    const tip = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/remotes/origin/main", tip);
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(cwd, "checkout", "-q", "feature");
    const r = ak(cwd, "unattended", "check", "--phase", "super-align");
    expect(r.code).toBe(0);
    const printed: unknown = JSON.parse(r.out);
    expect(printed).toMatchObject({ source: `default-branch:${tip}` });
  });

  test("a bypass grant is refused under the policy", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const r = ak(cwd, "bypass", "check", "--grant", join(cwd, "g.json"), "--task", "t", "--phase", "super-align");
    expect(r.code).toBe(1);
    expect(r.err).toContain("unattended");
    const recorded = ak(cwd, "record", "--gate", "align", "--bypass", join(cwd, "g.json"), "--task", "t", "--", ...ok);
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain("a bypass grant does not apply under the unattended policy");
    expect(recordsOf(cwd, "feature", "align")).toEqual([]);
  });

  test("a legacy run refuses an unattended record and an unattended check", () => {
    const cwd = repo();
    expect(ak(cwd, "open", "--ticket", ticketFile(cwd)).code).toBe(0);
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const recorded = ak(cwd, "record", "--gate", "build-checks", "--", ...ok);
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain(
      "was opened under the legacy policy, and this record resolves the unattended policy",
    );
    const checked = ak(cwd, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("was opened under the legacy policy, and this check resolves the unattended policy");
  });
});

describe("command evidence, import and the pre-ship check (command seam)", () => {
  test("phase gates are refused without the policy; under it the tool runs and records the command", () => {
    const cwd = repo();
    expect(ak(cwd, "record", "--gate", "align", "--", ...ok).code).toBe(1);
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(ak(cwd, "record", "--gate", "align").code).toBe(2);
    expect(ak(cwd, "record", "--gate", "align", "--", ...ok).code).toBe(0);
    const [first] = recordsOf(cwd, "feature", "align");
    expect(first?.policy).toEqual({ name: "unattended", source: "environment" });
    expect(first?.commands?.[0]).toMatchObject({ argv: ok, exit_status: 0, output: sha("ok\n") });
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "exit 3").code).toBe(1);
    expect(recordsOf(cwd, "feature", "align")[0]?.commands).toHaveLength(2);
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "echo x > src/b.js").code).toBe(1);
  });

  test("open imports pre-ticket records at the opening revision with their original times", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(ak(cwd, "record", "--gate", "bound", "--", ...ok).code).toBe(0);
    const [before] = recordsOf(cwd, "feature", "bound");
    const opened = ak(cwd, "open", "--ticket", ticketFile(cwd));
    expect(opened.code).toBe(0);
    const run = runId(opened.out);
    const [imported] = recordsOf(cwd, run, "bound");
    expect(imported?.commands).toEqual(before?.commands);
    expect(imported?.imported_from?.run).toBe("feature");
    expect((imported?.recorded_at ?? "") >= (before?.recorded_at ?? "~")).toBe(true);
    const runRecord: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", run, "run.json"), "utf8"));
    expect(runRecord).toMatchObject({ policy: { name: "unattended", source: "environment" } });
    const output = before?.commands?.[0]?.output ?? "";
    expect(existsSync(join(store(cwd), run, "artifacts", output.slice(7)))).toBe(true);
  });

  test("the pre-ship check needs all six phases with passing commands; a failing latest entry refuses", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    fullRun(cwd);
    const pass = ak(cwd, "check", "--json");
    expect(pass.code).toBe(0);
    const decision: unknown = JSON.parse(pass.out);
    expect(decision).toMatchObject({ outcome: "allowed", policy: { name: "unattended" }, trust: "worker-attested" });
    expect(ak(cwd, "record", "--gate", "review-readiness", "--", "sh", "-c", "exit 1").code).toBe(1);
    const failed = ak(cwd, "check");
    expect(failed.code).toBe(1);
    expect(failed.err).toContain("failed evidence");
  });

  test("a missing scout refuses, and a mismatched policy is refused in both directions", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(ak(cwd, "open", "--ticket", ticketFile(cwd)).code).toBe(0);
    const check = ak(cwd, "check");
    expect(check.code).toBe(1);
    expect(check.err).toContain("scout");
    setEnv({ AK_LIFECYCLE_POLICY: undefined });
    const recorded = ak(cwd, "record", "--gate", "build-checks");
    expect(recorded.code).toBe(1);
    expect(recorded.err).toContain(
      "was opened under the unattended policy, and this record resolves the legacy policy",
    );
    const checked = ak(cwd, "check");
    expect(checked.code).toBe(1);
    expect(checked.err).toContain("was opened under the unattended policy, and this check resolves the legacy policy");
  });

  test("a covering review-delta's command entries count like the full review's: tampered output refuses", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const { run, code } = deltaRun(cwd, ["sh", "-c", "echo delta"]);
    expect(code).toBe(0);
    expect(ak(cwd, "check").code).toBe(0);
    writeFileSync(join(store(cwd), run, "artifacts", sha("delta\n").slice(7)), "forged\n");
    const tampered = ak(cwd, "check");
    expect(tampered.code).toBe(1);
    expect(tampered.err).toContain(`gate review-delta evidence output ${sha("delta\n")} is absent or changed`);
  });

  test("a failed covering review-delta refuses as failed evidence", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    expect(deltaRun(cwd, ["sh", "-c", "echo bad; exit 1"]).code).toBe(1);
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain('gate review-delta failed evidence: ["sh","-c","echo bad; exit 1"] exited 1');
  });

  test("a covering review-delta without command entries refuses as missing evidence", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const { run } = deltaRun(cwd, ["sh", "-c", "echo delta"]);
    const [delta] = recordsOf(cwd, run, "review-delta");
    writeFileSync(recordFile(cwd, run, "review-delta"), JSON.stringify({ ...delta, commands: undefined }));
    expect(recordsOf(cwd, run, "review-delta")[0]?.commands).toBeUndefined();
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain("gate review-delta has no evidence command (missing evidence)");
  });

  test("a tampered stored output of a counted record refuses at check", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const run = fullRun(cwd);
    expect(ak(cwd, "record", "--gate", "build-checks", "--", "sh", "-c", "echo built").code).toBe(0);
    expect(ak(cwd, "check").code).toBe(0);
    writeFileSync(join(store(cwd), run, "artifacts", sha("built\n").slice(7)), "forged\n");
    const r = ak(cwd, "check");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`gate build-checks evidence output ${sha("built\n")} is absent or changed`);
  });

  test("a reused branch imports only the command entries recorded after its earlier run opened", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const ticketPath = ticketFile(cwd);
    const argvs = (run: string) => recordsOf(cwd, run, "align")[0]?.commands?.map((entry) => entry.argv.join(" "));
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "echo first").code).toBe(0);
    const first = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(argvs(first)).toEqual(["sh -c echo first"]);
    // The first task ships: its run closes, and the next task's phases land in the branch-named run again.
    const runJson = join(store(cwd), "runs", first, "run.json");
    const closedAt = `,\n  "closed_at": "${new Date().toISOString()}"\n}\n`;
    writeFileSync(runJson, readFileSync(runJson, "utf8").replace(/\n}\n$/, closedAt));
    expect(readFileSync(runJson, "utf8")).toContain('"closed_at"');
    expect(ak(cwd, "record", "--gate", "align", "--", "sh", "-c", "echo second").code).toBe(0);
    expect(argvs("feature")).toEqual(["sh -c echo first", "sh -c echo second"]);
    const second = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(argvs(second)).toEqual(["sh -c echo second"]);
    expect(recordsOf(cwd, second, "align")[0]?.imported_from?.run).toBe("feature");
  });

  test("an imported record whose every entry predates an earlier run's opening is not imported", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    const ticketPath = ticketFile(cwd);
    expect(ak(cwd, "record", "--gate", "bound", "--", ...ok).code).toBe(0);
    const first = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(recordsOf(cwd, first, "bound")).toHaveLength(1);
    const second = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    expect(recordsOf(cwd, second, "bound")).toEqual([]);
  });

  test("a host-unattested verifier is a note under the policy, with the implementer seat recorded", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended" });
    for (const g of ["align", "bound", "scout"]) expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
    const ticketPath = ticketFile(cwd);
    const run = runId(ak(cwd, "open", "--ticket", ticketPath).out);
    const seatFlags = ["--class", "red", "--author-kind", "agent", "--host", "claude-code", "--seat-id", "impl-1"];
    expect(ak(cwd, "record", "--gate", "build-checks", ...seatFlags, "--", ...ok).code).toBe(0);
    for (const g of ["review-full", "review-readiness"])
      expect(ak(cwd, "record", "--gate", g, "--", ...ok).code).toBe(0);
    const seat = {
      created_by: { role: "verifier" },
      verifier_seat: { id: "verifier-1", implementer_seat: "impl-1", isolation: "host-unattested", attestation: null },
    };
    expect(
      ak(cwd, "record", "--gate", "verify", "--receipt", receiptFile(cwd, run, ticketPath, seat), "--", ...ok).code,
    ).toBe(0);
    const r = ak(cwd, "check");
    expect(r.err).toContain("host-unattested");
    expect(r.code).toBe(0);
  });

  test("a legacy record keeps exactly its members", () => {
    const cwd = repo();
    expect(ak(cwd, "record", "--gate", "build-checks").code).toBe(0);
    const [legacy] = recordsOf(cwd, "feature", "build-checks");
    expect(Object.keys(legacy ?? {}).toSorted()).toEqual([
      "gate",
      "recorded_at",
      "run_id",
      "schema",
      "schema_version",
      "snapshot",
    ]);
  });
});

describe("ship-preflight and final ship success (command seam)", () => {
  test("against the unprotected live shape it refuses every item, writes nothing and makes only GET requests", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended", AK_UNATTENDED_READ_TOKEN: "read-token" });
    const run = fullRun(cwd);
    const log = stubGh(withFixtures(UNPROTECTED));
    const decisions = join(store(cwd), run, "decisions");
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(1);
    for (const item of ["code-owner", "required CI", CHECK]) expect(r.err).toContain(item);
    for (const assumption of RESIDUAL) expect(r.err).toContain(assumption);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual([]);
    expect(existsSync(decisions) ? readdirSync(decisions) : []).toEqual([]);
    expect(log().length).toBeGreaterThan(0);
    for (const line of log()) expect(line).toMatch(/^(GET |CLIENT auth status$)/);
    expect(log()).toContain(`GET ${PROTECTION_KEY} read`);
  });

  test("a protected fixture passes, prints the disclosure and command summary; the final append validates the pull request", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended", AK_UNATTENDED_READ_TOKEN: "read-token" });
    const run = fullRun(cwd);
    const compareKey = `repos/${REPO}/compare/${snapshotOf(cwd).revision}...${HEAD}`;
    const shipped = withFixtures({
      [compareKey]: { body: { status: "ahead", commits: [{ sha: HEAD, author: { login: "pipeline-bot" } }] } },
    });
    stubGh(shipped);
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(0);
    expect(r.out).toContain(DISCLOSURE);
    expect(r.out).toContain("align");
    for (const assumption of RESIDUAL) expect(r.err).toContain(assumption);
    expect(readdirSync(join(store(cwd), run, "decisions"))).toHaveLength(1);
    expect(recordsOf(cwd, run, "ship-preflight")[0]?.commands?.[0]?.builtin).toBe("merge-gate");

    stubGh({ ...shipped, ...runsWith([]) });
    expect(ak(cwd, "record", "--gate", "ship-preflight", "--pr", "7").code).toBe(3);

    stubGh(shipped);
    const final = ak(cwd, "record", "--gate", "ship-preflight", "--pr", "7");
    expect(final.code).toBe(0);
    expect(final.out).toContain("pipeline-bot");
    const entries = recordsOf(cwd, run, "ship-preflight")[0]?.commands ?? [];
    expect(entries.map((entry) => entry.builtin)).toEqual(["merge-gate", "final-ship"]);

    stubGh({ ...shipped, [compareKey]: { body: { status: "diverged", commits: [] } } });
    const diverged = ak(cwd, "record", "--gate", "ship-preflight", "--pr", "7");
    expect(diverged.code).toBe(1);
    expect(diverged.err).toContain("open a new run");
  });

  test("a run the final ship closed refuses a fresh ship-preflight and keeps its record as it was", () => {
    const cwd = repo();
    setEnv({ AK_LIFECYCLE_POLICY: "unattended", AK_UNATTENDED_READ_TOKEN: "read-token" });
    const run = fullRun(cwd);
    const compareKey = `repos/${REPO}/compare/${snapshotOf(cwd).revision}...${HEAD}`;
    stubGh(
      withFixtures({
        [compareKey]: { body: { status: "ahead", commits: [{ sha: HEAD, author: { login: "pipeline-bot" } }] } },
      }),
    );
    expect(ak(cwd, "record", "--gate", "ship-preflight").code).toBe(0);
    expect(ak(cwd, "record", "--gate", "ship-preflight", "--pr", "7").code).toBe(0);
    const runJson = join(store(cwd), "runs", run, "run.json");
    expect(readFileSync(runJson, "utf8")).toContain('"closed_at"');
    const before = { run: readFileSync(runJson, "utf8"), records: recordsOf(cwd, run, "ship-preflight") };
    expect(before.records[0]?.commands?.map((entry) => entry.builtin)).toEqual(["merge-gate", "final-ship"]);

    const again = ak(cwd, "record", "--gate", "ship-preflight");
    expect(again.code).toBe(1);
    expect(again.err).toContain("run closed; open a new run");
    expect(readFileSync(runJson, "utf8")).toBe(before.run);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual(before.records);
  });

  test("ship-preflight judges the run's own policy stamp: a repository source off the forge's default branch refuses", () => {
    const cwd = repo();
    git(cwd, "checkout", "-q", "main");
    writeFileSync(join(cwd, "ak.lifecycle.json"), JSON.stringify({ policy: "unattended" }));
    git(cwd, "add", "ak.lifecycle.json");
    git(cwd, "commit", "-q", "-m", "opt in");
    const stamped = git(cwd, "rev-parse", "HEAD");
    git(cwd, "update-ref", "refs/remotes/origin/main", stamped);
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(cwd, "checkout", "-q", "feature");
    const run = fullRun(cwd);
    const runRecord: unknown = JSON.parse(readFileSync(join(store(cwd), "runs", run, "run.json"), "utf8"));
    expect(runRecord).toMatchObject({ policy: { source: `default-branch:${stamped}` } });
    // This invocation resolves the policy from the environment; the run was stamped from the repository.
    setEnv({ AK_LIFECYCLE_POLICY: "unattended", AK_UNATTENDED_READ_TOKEN: "read-token" });
    stubGh(withFixtures({ [`repos/${REPO}/branches/main`]: { body: { commit: { sha: "e".repeat(40) } } } }));
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`read at ${stamped.slice(0, 12)}, which is not on main`);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual([]);
  });

  test("review-status is a standalone command for whoever merges", () => {
    const cwd = repo();
    setEnv({ AK_UNATTENDED_READ_TOKEN: "read-token" });
    stubGh(protectedFixtures());
    const r = ak(cwd, "unattended", "review-status", "--pr", "7");
    expect(r.code).toBe(0);
    for (const assumption of RESIDUAL) expect(r.err).toContain(assumption);
  });

  test("review-status hashes the comparison diff's raw bytes, not decoded text", () => {
    const cwd = repo();
    setEnv({ AK_UNATTENDED_READ_TOKEN: "read-token" });
    const raw = Buffer.concat([
      Buffer.from("diff --git a/x b/x\n+"),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from("\n"),
    ]);
    stubGh(
      withFixtures({
        [`repos/${REPO}/compare/${BASE}...${HEAD}#diff`]: { base64: raw.toString("base64") },
        ...runsWith([checkRun(1, result({ diff_sha256: sha(raw) }))]),
      }),
    );
    const r = ak(cwd, "unattended", "review-status", "--pr", "7");
    expect(r.err).not.toContain("diff digest");
    expect(r.code).toBe(0);
  });
});

/** The metadata file the review harness writes: the provider's reported model for the call. */
const meta = (model: string) => JSON.stringify({ provider_model: model });
/** A configuration whose reviewer is the alias `prov/latest`, written with stray case and space, for `target`. */
const aliasing = (target: string): JsonObject => ({
  ...CONFIG,
  independent_review: { ...REVIEW, reviewer_model: "prov/latest", model_aliases: { "Prov/Latest ": target } },
});

describe("the review workflow template", () => {
  const template = readFileSync(join(import.meta.dir, "../../skills/super-ship/assets/independent-review.yml"), "utf8");
  const [review = "", post = ""] = template.split(/^ {2}post:/m);

  test("runs only on pull_request_target and never checks out or runs pull-request code", () => {
    expect(template).toMatch(/^on:\n {2}pull_request_target:/m);
    expect(template).not.toMatch(/^ {2}(pull_request|push|workflow_dispatch|issue_comment):/m);
    expect(template).not.toContain("actions/checkout");
  });

  test("the review job holds no environment and reads only; the posting job holds the key and stamps identity itself", () => {
    expect(review).not.toMatch(/environment:/);
    expect(review).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read/);
    expect(review).toContain("< diff.patch");
    expect(post).toMatch(/environment: \$\{\{ vars\.AK_REVIEW_ENVIRONMENT \}\}/);
    for (const word of ["native_metadata", "reviewer_model", "author_models"]) expect(post).toContain(word);
    expect(post).not.toMatch(/\$\{\{[^}]*outputs\.[^}]*\}\}[^\n]*\n[^\n]*run:/);
  });

  test("the result moves only as a file, and the posting job re-derives what it stamps and posts", () => {
    expect(review).toContain("uses: actions/upload-artifact@");
    expect(review).not.toMatch(/^\s+outputs:/m);
    expect(post).toContain("uses: actions/download-artifact@");
    expect(post).not.toContain("needs.review.outputs");
    expect(post).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
    expect(post).toContain(
      'gh api --method GET -H "Accept: application/vnd.github.diff" "repos/$REPO/compare/$BASE_SHA...$HEAD_SHA" | sha256sum',
    );
    expect(post).toContain('"repos/$REPO/contents/ak.lifecycle.json?ref=$DEFAULT_BRANCH"');
    for (const key of ["check", "reviewer_model", "author_models", "model_aliases"])
      expect(post).toContain(`.independent_review.${key}`);
    expect(post).toMatch(
      /uses: actions\/create-github-app-token@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+app-id: \$\{\{ vars\.AK_REVIEW_APP_ID \}\}\n\s+private-key: \$\{\{ secrets\.AK_REVIEW_APP_KEY \}\}/,
    );
    expect(post).toContain("APP_TOKEN: ${{ steps.app.outputs.token }}");
    expect(post).toContain('jq -n --arg name "$check" --arg head "$HEAD_SHA"');
    expect(post).toContain('{name: $name, head_sha: $head, status: "completed"');
    expect(post).toContain('GH_TOKEN="$APP_TOKEN" gh api --method POST "repos/$REPO/check-runs" --input check.json');
  });

  /**
   * Runs the posting job's own stamping lines (its `canon` function through the `jq -n` program that builds
   * the result) over fixture configuration, metadata and verdict files, the forge reads replaced by fixtures.
   */
  function stamp(config: JsonObject, files: { metadata?: string; verdict: string }) {
    if (Bun.which("jq") === null) throw new Error("jq is not on the search path; the template test needs it");
    const lines = post.split("\n").map((line) => line.replace(/^ {10}/, ""));
    const from = lines.findIndex((line) => line.startsWith("check=$(jq"));
    const to = lines.findIndex((line) => line.startsWith("jq -n --arg name"));
    if (from < 0 || to <= from || !lines.slice(from, to).some((line) => line.startsWith("canon() {")))
      throw new Error("the template's stamping lines were not found");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ak-stamp-")));
    mkdirSync(join(dir, "review"));
    if (files.metadata !== undefined) writeFileSync(join(dir, "review", "metadata.json"), files.metadata);
    writeFileSync(join(dir, "review", "verdict.json"), files.verdict);
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const script = [
      "set -euo pipefail",
      "config=$(cat config.json)",
      `diff_sha256=${sha(DIFF)}`,
      ...lines.slice(from, to),
      'printf "%s\\n%s" "$conclusion" "$result"',
    ].join("\n");
    const p = Bun.spawnSync(["bash", "-c", script], {
      cwd: dir,
      env: { ...process.env, HEAD_SHA: HEAD, BASE_SHA: BASE },
    });
    if (p.exitCode !== 0) throw new Error(`the template's stamping lines failed: ${p.stderr.toString()}`);
    const [conclusion = "", ...rest] = p.stdout.toString().split("\n");
    const text = rest.join("\n");
    const parsed: unknown = JSON.parse(text);
    const status = reviewOf(
      withFixtures({ ...configWith(config), ...runsWith([checkRun(1, result(), { conclusion, output: { text } })]) }),
    );
    return { conclusion, parsed, status };
  }

  const approve = JSON.stringify({ verdict: "approve", findings: [] });

  test("a stamped approval passes the validator, the alias and case mapping agreeing in both implementations", () => {
    const plain = stamp(CONFIG, { metadata: meta("prov/model-b"), verdict: approve });
    expect(plain.conclusion).toBe("success");
    expect(plain.status.failures).toEqual([]);
    expect(plain.status.state).toBe("pass");
    const viaAlias = stamp(aliasing("prov/model-b"), { metadata: meta(" PROV/MODEL-B"), verdict: approve });
    expect(viaAlias.conclusion).toBe("success");
    expect(viaAlias.status.failures).toEqual([]);
    expect(viaAlias.parsed).toMatchObject({
      schema: "independent-review",
      head_sha: HEAD,
      base_sha: BASE,
      diff_sha256: sha(DIFF),
      input: "diff-only",
      reviewer: { sources: { configuration: "prov/latest", native_metadata: " PROV/MODEL-B" } },
    });
  });

  test("a reviewer that resolves to an author model is refused by the template and by the validator", () => {
    const stamped = stamp(aliasing("prov/model-a"), { metadata: meta("prov/model-a"), verdict: approve });
    expect(stamped.conclusion).toBe("failure");
    expect(stamped.parsed).toMatchObject({ verdict: "unavailable" });
    expect(stamped.status.state).toBe("refused");
    expect(stamped.status.failures.join("\n")).toContain("is an author model");
  });

  test("absent native metadata is refused by the template and by the validator", () => {
    const stamped = stamp(CONFIG, { verdict: approve });
    expect(stamped.conclusion).toBe("failure");
    expect(stamped.status.state).toBe("refused");
    expect(stamped.status.failures.join("\n")).toContain("lacks its configuration or native metadata source");
  });

  test("a reviewer identity forged in verdict.json is ignored: the stamp comes from configuration and metadata", () => {
    const forged = JSON.stringify({
      verdict: "approve",
      reviewer_model: "prov/model-b",
      reviewer: { model: "prov/model-b", sources: { configuration: "prov/model-b", native_metadata: "prov/model-b" } },
      findings: [{ text: "reviewed by prov/model-b" }],
    });
    const stamped = stamp(CONFIG, { metadata: meta("prov/model-a"), verdict: forged });
    expect(stamped.parsed).toMatchObject({
      reviewer: { model: "prov/model-b", sources: { configuration: "prov/model-b", native_metadata: "prov/model-a" } },
    });
    expect(stamped.conclusion).toBe("failure");
    expect(stamped.status.state).toBe("refused");
    expect(stamped.status.failures.join("\n")).toContain("disagree");
  });
});
