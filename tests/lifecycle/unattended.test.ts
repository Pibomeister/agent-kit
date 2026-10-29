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
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
const RUNS_KEY = `repos/${REPO}/commits/${HEAD}/check-runs?check_name=${encodeURIComponent(CHECK)}&filter=all&per_page=100`;
const CONFIG_KEY = `repos/${REPO}/contents/ak.lifecycle.json?ref=main`;
const OWNERS_KEY = `repos/${REPO}/contents/.github/CODEOWNERS?ref=main`;
const PROTECTION_KEY = `repos/${REPO}/branches/main/protection`;
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

interface Fixture {
  status?: number;
  headers?: Record<string, string>;
  body?: Json;
  /** A raw body, served as is (the comparison diff). */
  text?: string;
}
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
    [`repos/${REPO}/actions/secrets`]: { body: { secrets: [] } },
    [`repos/${REPO}/actions/organization-secrets`]: { body: { secrets: [] } },
    [`repos/${REPO}/environments`]: { body: { environments: [{ name: "independent-review" }, { name: "prod" }] } },
    [`repos/${REPO}/environments/prod/secrets`]: { body: { secrets: [{ name: "DEPLOY_KEY" }] } },
    [`repos/${REPO}/pulls/7`]: {
      body: { number: 7, base: { ref: "main", sha: BASE }, head: { sha: HEAD }, body: `Change.\n\n${DISCLOSURE}\n` },
    },
    [RUNS_KEY]: { body: { check_runs: [checkRun(1, result())] } },
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
const runsWith = (list: Json[]): FixtureMap => ({ [RUNS_KEY]: { body: { check_runs: list } } });

function memForge(fixtures: FixtureMap, log: string[] = []): Forge {
  return (path, options = {}) => {
    const key = options.accept?.includes("diff") === true ? `${path}#diff` : path;
    log.push(`${options.token === undefined ? "runner" : "read"} ${key}`);
    const fixture = fixtures[key];
    const body: Json = fixture === undefined ? { message: "Not Found" } : (fixture.body ?? null);
    return {
      status: fixture === undefined ? 404 : (fixture.status ?? 200),
      headers: fixture?.headers ?? {},
      body,
      text: fixture?.text ?? JSON.stringify(body),
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
        `repos/${REPO}/actions/organization-secrets`,
        `repos/${REPO}/actions/secrets`,
        PROTECTION_KEY,
        `repos/${REPO}/environments/prod/secrets`,
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
    const keyed = { body: { secrets: [{ name: "REVIEW_APP_KEY" }] } };
    expect(failuresOf(withFixtures({ [`repos/${REPO}/actions/secrets`]: keyed }))).toContain("REVIEW_APP_KEY");
    expect(failuresOf(withFixtures({ [`repos/${REPO}/environments/prod/secrets`]: keyed }))).toContain("prod");
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
const headers = Object.entries((f && f.headers) || {}).map(([k, v]) => k + ": " + v + "\\r\\n").join("");
process.stdout.write("HTTP/2.0 " + status + " X\\r\\n" + headers + "\\r\\n" + text);
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
    expect(ak(cwd, "record", "--gate", "build-checks").err).toContain("policy");
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
    const r = ak(cwd, "record", "--gate", "ship-preflight");
    expect(r.code).toBe(1);
    for (const item of ["code-owner", "required CI", CHECK]) expect(r.err).toContain(item);
    expect(recordsOf(cwd, run, "ship-preflight")).toEqual([]);
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

  test("review-status is a standalone command for whoever merges", () => {
    const cwd = repo();
    setEnv({ AK_UNATTENDED_READ_TOKEN: "read-token" });
    stubGh(protectedFixtures());
    expect(ak(cwd, "unattended", "review-status", "--pr", "7").code).toBe(0);
  });
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

  test("a result in the template's shape passes the validator", () => {
    for (const word of ["head_sha", "base_sha", "diff_sha256", "diff-only", "verdict", "findings", "schema_version"])
      expect(template).toContain(word);
    expect(reviewOf(protectedFixtures()).state).toBe("pass");
  });
});
