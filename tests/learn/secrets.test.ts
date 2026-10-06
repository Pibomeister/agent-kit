import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/learn/core/config.ts";
import { commandJudge, type JudgeTraceRow } from "../../src/learn/core/judge.ts";
import { scrubJsonText, scrubSecrets, SECRET_KINDS, type SecretKind } from "../../src/learn/core/secrets.ts";
import { gateText, readJsonl, SECRET_REDACTIONS_FILE, type RedactionRecord } from "../../src/learn/core/store.ts";
import { lessonDraft, proposeLesson } from "../../src/learn/kb.ts";
import { score, type Episode } from "../../src/learn/memory/episodes.ts";
import { ensureMemoryLedger, writeLesson } from "../../src/learn/memory/ledger.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { savePattern } from "../../src/learn/review/patterns.ts";
import { rollback } from "../../src/learn/review/propose.ts";
import { scratch, testContext } from "./helpers.ts";

// Every secret below is invented, and each is assembled at run time so that no
// token-shaped literal sits in the repository for a scanner to report.
const cat = (...parts: string[]) => parts.join("");
const body = (seed: string, length: number) => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);

const PEM_BODY = cat(body("MIIEinventedKeyMaterial0", 64), "\n", body("AAAAinventedLine+/", 40), "=");

/** One invented secret per pattern, in the context it would appear in. */
const CASES: ReadonlyArray<{ kind: SecretKind; name: string; secret: string; before?: string; after?: string }> = [
  {
    kind: "private-key",
    name: "an RSA key block",
    secret: cat("-----BEGIN ", "RSA PRIVATE KEY-----\n", PEM_BODY, "\n-----END ", "RSA PRIVATE KEY-----"),
  },
  {
    kind: "private-key",
    name: "an OpenSSH key block",
    secret: cat("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", PEM_BODY, "\n-----END ", "OPENSSH PRIVATE KEY-----"),
  },
  {
    kind: "private-key",
    name: "a PGP key block",
    secret: cat("-----BEGIN ", "PGP PRIVATE KEY BLOCK-----\n", PEM_BODY, "\n-----END ", "PGP PRIVATE KEY BLOCK-----"),
  },
  {
    kind: "private-key",
    name: "a key block JSON-escaped on one line",
    secret: cat(
      "-----BEGIN ",
      "EC PRIVATE KEY-----\\n",
      body("MHcCAQEEinvented", 48),
      "\\n-----END ",
      "EC PRIVATE KEY-----",
    ),
    before: '{"stdout":"',
    after: '"}',
  },
  {
    kind: "private-key",
    name: "a key header whose END line was cut off",
    secret: cat("-----BEGIN ", "PRIVATE KEY-----\n", PEM_BODY),
    after: " (truncated)",
  },
  { kind: "aws-access-key", name: "an AKIA key id", secret: cat("AK", "IA", "INVENTEDKEY12345") },
  { kind: "aws-access-key", name: "an ASIA session key id", secret: cat("AS", "IA", "INVENTEDKEY67890") },
  {
    kind: "aws-secret-key",
    name: "a secret access key in a credentials file",
    secret: body("Inv3nted/Secret+Value", 40),
    before: "aws_secret_access_key = ",
  },
  { kind: "github-token", name: "a classic token", secret: cat("gh", "p_", body("Inv3ntedT0ken", 36)) },
  { kind: "github-token", name: "an OAuth token", secret: cat("gh", "o_", body("Inv3ntedOauth", 36)) },
  {
    kind: "github-token",
    name: "a fine-grained token",
    secret: cat("github", "_pat_", body("11INVENTED0", 22), "_", body("inventedFineGrained", 59)),
  },
  { kind: "gitlab-token", name: "a personal access token", secret: cat("gl", "pat-", body("inventedGitlab_", 20)) },
  { kind: "slack-token", name: "a bot token", secret: cat("xo", "xb-", "1234567890-", body("inventedSlack", 24)) },
  {
    kind: "slack-webhook",
    name: "an incoming webhook",
    secret: cat("https://hooks.slack.com/", "services/T0INVENT1/B0INVENT2/", body("inventedHook", 24)),
  },
  { kind: "anthropic-key", name: "an API key", secret: cat("sk-", "ant-", "api03-", body("inventedKey_", 48)) },
  { kind: "openai-key", name: "a project key", secret: cat("sk-", "proj-", body("inventedProject-", 48)) },
  { kind: "stripe-key", name: "a live secret key", secret: cat("sk", "_live_", body("inventedStripe0", 24)) },
  { kind: "google-api-key", name: "an API key", secret: cat("AI", "za", body("inventedGoogleKey_", 35)) },
  { kind: "npm-token", name: "an access token", secret: cat("np", "m_", body("inventedNpm0", 36)) },
  {
    kind: "jwt",
    name: "a signed token",
    secret: cat("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiJpbnZlbnRlZCJ9.", body("inventedSignature-", 32)),
  },
  {
    kind: "bearer-token",
    name: "an opaque bearer token",
    secret: body("inv3nted.opaque-token_", 32),
    before: "curl -H 'Authorization: Bearer ",
    after: "' https://api.example.test",
  },
  {
    kind: "basic-auth",
    name: "basic credentials",
    secret: "aW52ZW50ZWQ6Y3JlZGVudGlhbHM=",
    before: "Authorization: Basic ",
  },
  {
    kind: "url-credentials",
    name: "a password in a database URL",
    secret: cat("app:", "inventedPassw0rd"),
    before: "postgres://",
    after: "@db.internal:5432/app",
  },
];

describe("secret patterns", () => {
  test("every kind has at least one invented case", () => {
    const covered = new Set<string>([...CASES.map((c) => c.kind), "home-path"]);
    expect(SECRET_KINDS.filter((kind) => !covered.has(kind))).toEqual([]);
  });

  for (const c of CASES) {
    test(`${c.kind}: ${c.name} is replaced by its marker, and the text around it stays`, () => {
      const before = c.before ?? "lesson: the session pasted ";
      const after = c.after ?? " into the shell.";
      const { text, found } = scrubSecrets(`${before}${c.secret}${after}`);
      expect(text).toBe(`${before}[redacted:${c.kind}]${after}`);
      expect(found).toEqual({ [c.kind]: 1 });
    });
  }

  test("a JWT after Bearer is reported as a JWT, once", () => {
    const jwt = cat("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiJpbnZlbnRlZCJ9.", body("inventedSig", 24));
    const { text, found } = scrubSecrets(`Authorization: Bearer ${jwt}`);
    expect(text).toBe("Authorization: Bearer [redacted:jwt]");
    expect(found).toEqual({ jwt: 1 });
  });

  test("several secrets in one text are each counted, and a scrubbed text scrubs to itself", () => {
    const token = cat("gh", "p_", body("Inv3ntedT0ken", 36));
    const key = cat("AK", "IA", "INVENTEDKEY12345");
    const first = scrubSecrets(`${token} and ${key} and ${token} at /home/alice/app`);
    expect(first.found).toEqual({ "github-token": 2, "aws-access-key": 1, "home-path": 1 });
    const again = scrubSecrets(first.text);
    expect(again.text).toBe(first.text);
    expect(again.found).toEqual({});
  });
});

/** Strings shaped like the patterns' neighbours that carry no credential. Each must pass untouched. */
const FALSE_POSITIVES: readonly string[] = [
  "Bearer tokens are sent in the Authorization header.",
  "Authorization: Bearer <token>",
  "Authorization: Bearer $GITHUB_TOKEN",
  'WWW-Authenticate: Basic realm="api"',
  "commit 0123456789abcdef0123456789abcdef01234567 fixed it",
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "request id 550e8400-e29b-41d4-a716-446655440000",
  "AKIA prefixes mark long-lived AWS keys and ASIA prefixes temporary ones.",
  "ghp_ tokens are classic GitHub tokens; github_pat_ ones are fine-grained.",
  "the xoxb- prefix is a Slack bot token",
  "desk-proj-planning-board-2026 and risk-ant-farm-simulation-0001",
  "npm_config_cache is set by npm itself",
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
  "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBa\n-----END CERTIFICATE-----",
  "a JWT starts with eyJ because it encodes an opening brace",
  "https://example.com/home/index.html",
  "https://github.com/acme/app/pull/1#discussion_r9",
  "git@github.com:acme/app.git",
  "https://alice@example.com/repo.git",
  "https://user:${TOKEN}@example.com/repo.git",
  "redis://:${REDIS_PASSWORD}@cache.internal:6379",
  "postgres://app:<password>@db.internal/app",
  "/usr/local/bin/bun",
  "~/projects/app/src/index.ts",
  "$HOME/.config/agent-kit",
  "/homepage and /home and /home/ alone",
  "/Users/Shared/Logs/build.log",
  "/rootfs/etc/hosts",
  "/var/lib/app/data.db",
  "src/home/view.ts and ./home/alice/notes.md",
  "/tmp/ak-learn-x/ledger",
];

describe("the false-positive set", () => {
  for (const text of FALSE_POSITIVES) {
    test(`untouched: ${JSON.stringify(text).slice(0, 70)}`, () => {
      expect(scrubSecrets(text)).toEqual({ text, found: {} });
    });
  }
});

describe("home paths", () => {
  const H = "[redacted:home-path]";
  const PATHS: ReadonlyArray<readonly [string, string]> = [
    ["Linux: edited /home/alice/src/app.ts", `Linux: edited ${H}/src/app.ts`],
    ["Linux, bare: cd /home/alice", `Linux, bare: cd ${H}`],
    ["Linux, dotted name: /home/first.last/x", `Linux, dotted name: ${H}/x`],
    ["Linux, dashed name: /home/ci-runner/work/x", `Linux, dashed name: ${H}/work/x`],
    ["Fedora Atomic: /var/home/alice/x", `Fedora Atomic: ${H}/x`],
    ["root: /root/.ssh/config", `root: ${H}/.ssh/config`],
    ["macOS: /Users/bob/Library/Caches/x", `macOS: ${H}/Library/Caches/x`],
    ["macOS, dotted name: /Users/bob.smith/dev", `macOS, dotted name: ${H}/dev`],
    ["file URL: file:///Users/bob/notes.md", `file URL: file://${H}/notes.md`],
    ["file URL: file:///home/alice/notes.md", `file URL: file://${H}/notes.md`],
    ["PATH=/home/alice/bin:/home/alice/.local/bin", `PATH=${H}/bin:${H}/.local/bin`],
    ["quoted: '/home/alice/x' \"/Users/bob/y\" `/home/carol/z`", `quoted: '${H}/x' "${H}/y" \`${H}/z\``],
    [
      "bracketed: (/home/alice/x) [/Users/bob/y] {/home/carol/z} </Users/dan/w>",
      `bracketed: (${H}/x) [${H}/y] {${H}/z} <${H}/w>`,
    ],
    ["listed: /home/alice/a,/home/bob/b;/Users/carol/c|/Users/dan/d", `listed: ${H}/a,${H}/b;${H}/c|${H}/d`],
    ["first line\n/home/alice/x at a line start", `first line\n${H}/x at a line start`],
  ];
  for (const [input, expected] of PATHS) {
    test(JSON.stringify(input).slice(0, 70), () => {
      const { text, found } = scrubSecrets(input);
      expect(text).toBe(expected);
      expect(found["home-path"]).toBe(expected.split(H).length - 1);
    });
  }

  test("serialized JSON stays JSON and loses only the home prefix, escaped line breaks included", () => {
    const row = {
      cwd: "/Users/bob/app",
      files: ["/home/alice/app/a.ts", "rel/b.ts"],
      log: 'line one\n/home/alice/x said "/Users/bob/y"\tand \\home\\carol',
      n: 3,
      ok: true,
      none: null,
    };
    const { text, found } = scrubJsonText(JSON.stringify(row));
    expect(text).toBe(
      JSON.stringify({
        ...row,
        cwd: "[redacted:home-path]/app",
        files: ["[redacted:home-path]/app/a.ts", "rel/b.ts"],
        log: 'line one\n[redacted:home-path]/x said "[redacted:home-path]/y"\tand \\home\\carol',
      }),
    );
    expect(found).toEqual({ "home-path": 4 });
  });

  test("a match never spans two JSON values", () => {
    const pem = cat("-----BEGIN ", "RSA PRIVATE KEY-----");
    const json = JSON.stringify({ a: `${pem}\nMIIE`, b: "plain", c: cat("-----END ", "RSA PRIVATE KEY-----") });
    const { text, found } = scrubJsonText(json);
    expect(text).toBe(
      JSON.stringify({ a: "[redacted:private-key]", b: "plain", c: cat("-----END ", "RSA PRIVATE KEY-----") }),
    );
    expect(found).toEqual({ "private-key": 1 });
  });
});

/** An ended, completed episode touching `files`, before scoring. */
function episode(sid: string, files: string[], started: number): Omit<Episode, "priority"> {
  return {
    sid,
    platform: "claude-code",
    started,
    ended: started + 1,
    prompts: 1,
    obs: 1,
    tokens: 100,
    files_modified: files,
    request: null,
    completed: true,
    failure_signals: 0,
    corrections: 0,
    review_events: 0,
  };
}

describe("the gate", () => {
  const token = cat("gh", "p_", body("Inv3ntedT0ken", 36));

  test("a gated text is written redacted, and the record names the file and kinds but never the value", () => {
    const dir = scratch();
    const path = join(dir, "log.md");
    expect(gateText(dir, path, `- pushed with ${token} from /home/alice/app\n`)).toBe(
      "- pushed with [redacted:github-token] from [redacted:home-path]/app\n",
    );
    const raw = readFileSync(join(dir, SECRET_REDACTIONS_FILE), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("alice");
    const rows = readJsonl<RedactionRecord>(join(dir, SECRET_REDACTIONS_FILE));
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => [row.file, row.kinds])).toEqual([["log.md", { "github-token": 1, "home-path": 1 }]]);
  });

  test("clean text records nothing", () => {
    const dir = scratch();
    expect(gateText(dir, join(dir, "log.md"), "- nothing to see\n")).toBe("- nothing to see\n");
    expect(existsSync(join(dir, SECRET_REDACTIONS_FILE))).toBe(false);
  });

  test("a recorded lesson is written redacted and the ledger records it", () => {
    const ledger = ensureMemoryLedger(join(scratch(), "memory"));
    mkdirSync(ledger.path("lessons"), { recursive: true });
    const path = ledger.path("lessons", "ls-001.md");
    writeLesson(path, { id: "ls-001", statement: `Never echo ${token} in CI.` }, "");
    const page = readFileSync(path, "utf8");
    expect(page).toContain("Never echo [redacted:github-token] in CI.");
    expect(page).not.toContain(token);
    const rows = readJsonl<RedactionRecord>(ledger.path(SECRET_REDACTIONS_FILE));
    expect(rows.map((row) => [row.file, row.kinds])).toEqual([["lessons/ls-001.md", { "github-token": 1 }]]);
  });

  test("the knowledgebase receives the draft after the gate", () => {
    const base = scratch();
    const seen = join(base, "seen");
    const ctx = testContext({ env: { AK_LEARN_KB_COMMAND: `cat > ${seen}; echo '{"ref":"kb:lesson/1"}'; true` } });
    const ledger = join(base, "ledger");
    const draft = lessonDraft(
      {
        localId: "ls-004",
        title: "Keep tokens out of scripts",
        statement: `A script under /Users/bob/app embedded ${token}; read it from the environment instead.`,
        trigger: "correction",
        occurrence: { id: "obs-9", content: { title: "token in script" } },
        evidence: [{ ref: "claude-mem:obs-9", kind: "transcript" }],
        domains: ["security"],
        createdBy: "learn/consolidator",
      },
      { root: "/work/app", repo: "acme/app", revision: null },
      "learn-memory-20261005",
      new Date("2026-10-05T10:00:00Z"),
    );
    expect(proposeLesson(ctx, ledger, draft)).toEqual({ ref: "kb:lesson/1", delivered: true });
    const sent = readFileSync(seen, "utf8");
    expect(sent).not.toContain(token);
    expect(sent).not.toContain("/Users/bob");
    expect(sent).toContain(
      '"statement":"A script under [redacted:home-path]/app embedded [redacted:github-token]; read it from the environment instead."',
    );
    const record = readFileSync(join(ledger, "proposals", "learn-app-ls-004.json"), "utf8");
    expect(record).not.toContain(token);
    const rows = readJsonl<RedactionRecord>(join(ledger, SECRET_REDACTIONS_FILE));
    expect(rows.map((row) => row.kinds)).toEqual([{ "home-path": 1, "github-token": 1 }]);
  });

  test("a fresh episode's home path is compared in its stored form, so a seen file is not novel", () => {
    const now = 1_000_000;
    const stored: Episode = { ...episode("s-old", ["[redacted:home-path]/app/a.ts"], now - 10), priority: 0 };
    const priority = (file: string) => score([episode("s-new", [file], now - 5)], [stored], now).map((e) => e.priority);
    const [seen] = priority("/home/alice/app/a.ts");
    const [novel] = priority("/home/alice/app/b.ts");
    expect((novel ?? 0) - (seen ?? 0)).toBeCloseTo(0.1, 4);
    expect(seen).toBeGreaterThan(0);
  });

  test("full judge tracing writes the prompt body after the gate and records it in the runtime directory", () => {
    const dir = scratch();
    const script = join(dir, "judge.sh");
    writeFileSync(script, `printf '%s\\n' '{"result":"{\\"answer\\":\\"kept\\"}"}'\n`);
    const config = {
      ...loadConfig({ CLAUDE_CONFIG_DIR: join(dir, "config"), AK_LEARN_TRACE: "full" }),
      judgeCommand: ["sh", script],
      judgeTimeoutMs: 10_000,
    };
    const judge = commandJudge(config);
    expect(
      judge(`observation: ran with ${token}`, { loop: "memory", role: "reflector", project: "shop", runId: null }),
    ).toEqual({ answer: "kept" });
    const [row] = readJsonl<JudgeTraceRow>(join(config.runtimeDir, "judge-calls.jsonl"));
    if (row === undefined) throw new Error("expected a judge trace row");
    const prompt = readFileSync(join(config.runtimeDir, "judge-bodies", `${row.call_id}.prompt`), "utf8");
    expect(prompt).toBe("observation: ran with [redacted:github-token]");
    const rows = readJsonl<RedactionRecord>(join(config.runtimeDir, SECRET_REDACTIONS_FILE));
    expect(rows.map((r) => [r.file, r.kinds])).toEqual([[`judge-bodies/${row.call_id}.prompt`, { "github-token": 1 }]]);
  });

  test("a review rollback keeps the redaction record append-only", () => {
    const ctx = testContext();
    const ledger = reviewLedger(ctx.config, scratch());
    savePattern({
      id: "rp-001",
      meta: { id: "rp-001", title: "token in a review comment", status: "candidate", count: 1 },
      body: `## Problem\nThe reviewer quoted ${token}.\n`,
      path: ledger.path("patterns", "rp-001.md"),
    });
    ledger.commit("maintain: rp-001");
    const record = readFileSync(ledger.path(SECRET_REDACTIONS_FILE), "utf8");
    expect(rollback(ledger)).toBe("reverted 'maintain: rp-001'");
    expect(existsSync(ledger.path("patterns", "rp-001.md"))).toBe(false);
    expect(readFileSync(ledger.path(SECRET_REDACTIONS_FILE), "utf8")).toBe(record);
    expect(ledger.git(["status", "--porcelain"]).stdout.trim()).toBe("");
  });
});
