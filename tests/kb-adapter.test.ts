import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import commonSchema from "../schemas/common.schema.json" with { type: "json" };
import charterExample from "../templates/charter.example.json" with { type: "json" };
import decisionExample from "../templates/decision.example.json" with { type: "json" };
import { runCli } from "../src/cli.ts";
import { ARTIFACT_SCHEMA_IDS } from "../src/kb/artifacts.ts";
import {
  BACKEND_SCHEMAS_DIR,
  BACKEND_VALIDATORS,
  BACKENDS_DIR,
  BINDING_FILE,
  findKbProjectRoot,
  loadKbBinding,
  resolveKnowledgebase,
} from "../src/kb/binding.ts";
import { EXIT_UNAVAILABLE, runKb } from "../src/kb/cli.ts";
import { KB_KINDS } from "../src/kb/local-git.ts";
import { checkKnowledgebase } from "../src/maintenance/cli.ts";

/**
 * adapters/knowledgebase/CONTRACT.md §6 and §7, ruling `kb-binding-is-a-locator`.
 *
 * The regression this file holds: a lifecycle run in a task copy of a bound
 * project reaches the knowledgebase without any setup of its own, and a
 * project that binds none is told so, with the step that would bind one, while
 * nothing is written into the working repository.
 *
 * Every repository here is a fixture in a temporary directory and the registry
 * is a scratch file; nothing reads the operator's own registry or knowledgebase.
 */

const REPO = join(import.meta.dir, "..");

const BINDING = `backend: local-git
project: example-project
locator:
  knowledgebase: fixture-kb
`;

const PAGE = "# Queue the exports\n\nExports run on a queue, because a request cannot wait for one.\n";

function git(dir: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
}

/** A repository whose commits need nothing from the operator's own git configuration. */
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", "/dev/null");
  return realpathSync(dir);
}

interface Fixture {
  /** The project's main checkout, with the binding committed unless the fixture is unbound. */
  project: string;
  kb: string;
  registry: string;
  scratch: string;
}

function fixture(binding: string | null = BINDING): Fixture {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ak-kb-")));
  const project = initRepo(join(scratch, "project"));
  writeFileSync(join(project, "README.md"), "# example\n");
  if (binding !== null) writeFileSync(join(project, BINDING_FILE), binding);
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "fixture");
  return { project, kb: initRepo(join(scratch, "kb")), registry: join(scratch, "registry.json"), scratch };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function kb(fx: Fixture, cwd: string, ...argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const code = runKb(argv, { cwd, io, registry: fx.registry });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A bound project with its knowledgebase registered: the configured case. */
function registered(): Fixture {
  const fx = fixture();
  expect(kb(fx, fx.project, "register", "fixture-kb", fx.kb).code).toBe(0);
  return fx;
}

/** A task copy: a linked work tree of the project, as a crew's worker gets. */
function taskCopy(fx: Fixture): string {
  const copy = join(fx.scratch, "task-copy");
  git(fx.project, "worktree", "add", "-q", "-b", "task/one", copy);
  return realpathSync(copy);
}

function page(fx: Fixture, text: string = PAGE): string {
  const file = join(fx.scratch, `page-${readdirSync(fx.scratch).length}.md`);
  writeFileSync(file, text);
  return file;
}

function publishPage(fx: Fixture, cwd: string, file: string, ...extra: string[]): Run {
  return kb(
    fx,
    cwd,
    "publish",
    "document",
    "--kind",
    "adr",
    "--scope",
    "billing/exports",
    "--id",
    "queue-the-exports",
    "--title",
    "Queue the exports",
    "--file",
    file,
    ...extra,
  );
}

interface Published {
  status: string;
  ref: string;
  content_hash: string;
  idempotency_key: string;
  run: string | null;
  revision: string;
  effect: string;
}

interface Refusal {
  status: string;
  code: string;
  message: string;
}

interface PageRead {
  ref: string;
  kind: string;
  scope: string;
  status: string;
  content_hash: string;
  revision: string;
  body: string;
}

interface ReadResult {
  status: string;
  documents: PageRead[];
  coverage: { kinds: string[]; scopes: string[]; unreadable: string[]; run_artifact_links: string };
}

const ajv = new Ajv2020({ strict: false });
const isPublished = ajv.compile<Published>({
  type: "object",
  required: ["status", "ref", "content_hash", "idempotency_key", "run", "revision", "effect"],
});
const isRefusal = ajv.compile<Refusal>({ type: "object", required: ["status", "code", "message"] });
const isRead = ajv.compile<ReadResult>({ type: "object", required: ["status", "documents", "coverage"] });

function published(run: Run): Published {
  const value: unknown = JSON.parse(run.out);
  if (!isPublished(value)) throw new Error(`not a publish result: ${run.out}`);
  return value;
}

function refusal(run: Run): Refusal {
  const value: unknown = JSON.parse(run.out);
  if (!isRefusal(value)) throw new Error(`not a refusal: ${run.out}`);
  return value;
}

function readResult(run: Run): ReadResult {
  const value: unknown = JSON.parse(run.out);
  if (!isRead(value)) throw new Error(`not a read result: ${run.out}`);
  return value;
}

/** Commits in the repository; zero for one that has none yet. */
function commits(repo: string): number {
  return Number(git(repo, "rev-list", "--count", "--all").trim());
}

/** A schema-valid run artifact, from this package's own example; it names the fixture's project and run `example-run-1`. */
function decision(fx: Fixture, changed: Partial<typeof decisionExample> = {}, without: readonly string[] = []): string {
  const kept = Object.entries({ ...decisionExample, ...changed }).filter(([key]) => !without.includes(key));
  const file = join(fx.scratch, `decision-${readdirSync(fx.scratch).length}.json`);
  writeFileSync(file, JSON.stringify(Object.fromEntries(kept)));
  return file;
}

describe("a task copy reaches the knowledgebase its project binds", () => {
  test("check, read and publish work from a linked work tree with no setup of its own", () => {
    const fx = registered();
    const copy = taskCopy(fx);

    const check = kb(fx, copy, "check");
    expect(check.code).toBe(0);
    expect(check.out).toContain("ak kb check: bound.");
    expect(check.out).toContain("project 'example-project'");

    const empty = kb(fx, copy, "read", "--kind", "adr,concept", "--scope", "billing/exports");
    expect(empty.code).toBe(0);
    expect(readResult(empty).documents).toEqual([]);

    const sent = publishPage(fx, copy, page(fx), "--run", "run-1");
    expect(sent.code).toBe(0);
    expect(published(sent).effect).toBe("published");
    expect(published(sent).ref).toBe("doc:billing/exports/adr/queue-the-exports");

    const read = readResult(kb(fx, copy, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents.map((doc) => doc.ref)).toEqual(["doc:billing/exports/adr/queue-the-exports"]);
    expect(read.documents[0]?.content_hash).toBe(published(sent).content_hash);
    expect(read.documents[0]?.revision).toBe(published(sent).revision);
    expect(read.documents[0]?.body).toBe(PAGE);
  });

  test("the publish lands in the knowledgebase repository and the working repository stays untouched", () => {
    const fx = registered();
    const copy = taskCopy(fx);
    const before = git(fx.project, "rev-parse", "HEAD").trim();
    publishPage(fx, copy, page(fx));
    expect(commits(fx.kb)).toBe(1);
    expect(git(fx.kb, "status", "--porcelain")).toBe("");
    expect(git(copy, "status", "--porcelain")).toBe("");
    expect(git(fx.project, "status", "--porcelain")).toBe("");
    expect(git(fx.project, "rev-parse", "HEAD").trim()).toBe(before);
    expect(git(copy, "rev-parse", "HEAD").trim()).toBe(before);
  });

  test("a subdirectory of the task copy binds what its root binds", () => {
    const fx = registered();
    const copy = taskCopy(fx);
    mkdirSync(join(copy, "src", "deep"), { recursive: true });
    expect(findKbProjectRoot(join(copy, "src", "deep"))).toBe(copy);
    expect(kb(fx, join(copy, "src", "deep"), "check").code).toBe(0);
  });

  test("the root CLI reaches the same commands", () => {
    const fx = fixture(null);
    const out: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
    expect(runCli(["kb", "help"], { cwd: fx.project, io })).toBe(0);
    expect(out.join("\n")).toContain("ak kb publish document");
    out.length = 0;
    expect(runCli([], { cwd: fx.project, io })).not.toBe(0);
    expect(out.join("\n")).toContain("ak kb ");
  });
});

describe("no knowledgebase configured", () => {
  test("an unbound project reads unavailable, with the step that binds one", () => {
    const fx = fixture(null);
    const read = kb(fx, fx.project, "read", "--kind", "adr", "--scope", "project");
    expect(read.code).toBe(EXIT_UNAVAILABLE);
    const result = refusal(read);
    expect(result.status).toBe("unavailable");
    expect(result.code).toBe("kb.unbound");
    expect(result.message).toContain(BINDING_FILE);
    expect(result.message).toContain("ak kb register");
  });

  test("the unavailable message says ak.install.yaml is not the cause", () => {
    const fx = fixture(null);
    const check = kb(fx, fx.project, "check");
    expect(check.code).toBe(EXIT_UNAVAILABLE);
    expect(check.out).toContain("ak.install.yaml is not part of this");
  });

  test("an unbound project refuses a publish and creates nothing in the working repository", () => {
    const fx = fixture(null);
    const sent = publishPage(fx, fx.project, page(fx));
    expect(sent.code).toBe(EXIT_UNAVAILABLE);
    expect(refusal(sent).status).toBe("refused");
    expect(git(fx.project, "status", "--porcelain")).toBe("");
    expect(existsSync(join(fx.project, "projects"))).toBe(false);
    expect(existsSync(join(fx.project, "docs"))).toBe(false);
    expect(commits(fx.kb)).toBe(0);
  });

  test("a bound project on a machine that registered nothing is unavailable, not failed", () => {
    const fx = fixture();
    const check = kb(fx, fx.project, "check");
    expect(check.code).toBe(EXIT_UNAVAILABLE);
    expect(check.out).toContain("kb.unregistered");
    const read = kb(fx, fx.project, "read", "--kind", "adr", "--scope", "project");
    expect(read.code).toBe(EXIT_UNAVAILABLE);
    expect(refusal(read).status).toBe("unavailable");
    expect(refusal(publishPage(fx, fx.project, page(fx))).status).toBe("refused");
  });
});

describe("a configured knowledgebase that cannot be used is failed", () => {
  test("a binding that does not parse or match its schema", () => {
    const invalid = fixture("backend: local-git\nproject: example-project\nlocator:\n  path: /somewhere\n");
    expect(loadKbBinding(invalid.project).issues.map((issue) => issue.rule)).toEqual(["kb.binding-invalid"]);
    expect(kb(invalid, invalid.project, "check").code).toBe(1);
    const unknown = fixture("backend: wiki\nproject: example-project\nlocator:\n  space: eng\n");
    expect(loadKbBinding(unknown.project).issues.map((issue) => issue.rule)).toEqual(["kb.backend-unknown"]);
    const broken = fixture("backend: [local-git\n");
    expect(loadKbBinding(broken.project).issues.map((issue) => issue.rule)).toEqual(["kb.binding-unparseable"]);
    const read = kb(broken, broken.project, "read", "--kind", "adr", "--scope", "project");
    expect(read.code).toBe(1);
    expect(refusal(read).status).toBe("failed");
  });

  test("the binding names no machine path", () => {
    const fx = fixture(`backend: local-git\nproject: example-project\nlocator:\n  knowledgebase: /Users/someone/kb\n`);
    expect(loadKbBinding(fx.project).issues.map((issue) => issue.rule)).toEqual(["kb.binding-invalid"]);
  });

  test("a registered checkout that is gone or is not a repository", () => {
    const fx = fixture();
    writeFileSync(
      fx.registry,
      JSON.stringify({ knowledgebases: { "fixture-kb": { path: join(fx.scratch, "gone") } } }),
    );
    expect(resolveKnowledgebase(fx.project, fx.registry).issues.map((issue) => issue.rule)).toEqual([
      "kb.root-missing",
    ]);
    mkdirSync(join(fx.scratch, "plain"));
    writeFileSync(
      fx.registry,
      JSON.stringify({ knowledgebases: { "fixture-kb": { path: join(fx.scratch, "plain") } } }),
    );
    const resolution = resolveKnowledgebase(fx.project, fx.registry);
    expect(resolution.state).toBe("failed");
    expect(resolution.issues.map((issue) => issue.rule)).toEqual(["kb.root-not-a-repository"]);
  });

  test("a registry that is not a registry", () => {
    const fx = fixture();
    writeFileSync(fx.registry, JSON.stringify({ knowledgebases: { "fixture-kb": fx.kb } }));
    const resolution = resolveKnowledgebase(fx.project, fx.registry);
    expect(resolution.state).toBe("failed");
    expect(resolution.issues.map((issue) => issue.rule)).toEqual(["kb.registry-invalid"]);
  });
});

describe("the knowledgebase is never the application repository", () => {
  test("the project's own checkout cannot be registered as its knowledgebase", () => {
    const fx = fixture();
    const run = kb(fx, fx.project, "register", "fixture-kb", fx.project);
    expect(run.code).toBe(1);
    expect(run.out).toContain("kb.root-inside-project");
    expect(existsSync(fx.registry)).toBe(false);
  });

  test("a knowledgebase can be registered from inside its own checkout", () => {
    const fx = fixture();
    const run = kb(fx, fx.kb, "register", "fixture-kb", ".");
    expect(run.code).toBe(0);
    expect(kb(fx, fx.project, "check").code).toBe(0);
  });

  test("a registration pointing at a work tree of the project is refused on every operation", () => {
    const fx = fixture();
    const copy = taskCopy(fx);
    const other = join(fx.scratch, "other-copy");
    git(fx.project, "worktree", "add", "-q", "-b", "task/two", other);
    writeFileSync(fx.registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: other } } }));
    const resolution = resolveKnowledgebase(copy, fx.registry);
    expect(resolution.state).toBe("failed");
    expect(resolution.issues.map((issue) => issue.rule)).toEqual(["kb.root-inside-project"]);
    const sent = publishPage(fx, copy, page(fx));
    expect(sent.code).toBe(1);
    expect(refusal(sent).status).toBe("failed");
    expect(git(other, "status", "--porcelain")).toBe("");
  });

  test("a repository nested inside the project tree is refused", () => {
    const fx = fixture();
    const nested = initRepo(join(fx.project, "kb"));
    writeFileSync(fx.registry, JSON.stringify({ knowledgebases: { "fixture-kb": { path: nested } } }));
    expect(resolveKnowledgebase(fx.project, fx.registry).issues.map((issue) => issue.rule)).toEqual([
      "kb.root-inside-project",
    ]);
  });

  test("a hook's GIT_DIR does not redirect a publish into the working repository", () => {
    const fx = registered();
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(fx.project, ".git");
    process.env.GIT_WORK_TREE = fx.project;
    try {
      expect(publishPage(fx, fx.project, page(fx)).code).toBe(0);
    } finally {
      if (saved.dir === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env.GIT_DIR = saved.dir;
      if (saved.tree === undefined) Reflect.deleteProperty(process.env, "GIT_WORK_TREE");
      else process.env.GIT_WORK_TREE = saved.tree;
    }
    expect(commits(fx.kb)).toBe(1);
    expect(commits(fx.project)).toBe(1);
    expect(git(fx.project, "status", "--porcelain")).toBe("");
  });
});

describe("publishArtifact, kb-document placement", () => {
  test("there is no tenth kind", () => {
    const fx = registered();
    const sent = kb(
      fx,
      fx.project,
      "publish",
      "document",
      "--kind",
      "runbook",
      "--scope",
      "project",
      "--id",
      "restart",
      "--title",
      "Restart",
      "--file",
      page(fx),
    );
    expect(sent.code).toBe(1);
    expect(refusal(sent).code).toBe("kb.kind-unknown");
    expect(commits(fx.kb)).toBe(0);
    expect(KB_KINDS).toHaveLength(9);
  });

  test("an adr is stored proposed and no request can accept it", () => {
    const fx = registered();
    publishPage(fx, fx.project, page(fx));
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents[0]?.status).toBe("proposed");

    const accepted = page(fx, `---\nstatus: accepted\n---\n\n${PAGE}`);
    const sent = kb(
      fx,
      fx.project,
      "publish",
      "document",
      "--kind",
      "adr",
      "--scope",
      "project",
      "--id",
      "self-accepted",
      "--title",
      "Self accepted",
      "--file",
      accepted,
    );
    expect(sent.code).toBe(1);
    expect(refusal(sent).code).toBe("kb.body-has-header");
    const flagged = publishPage(fx, fx.project, page(fx), "--status", "accepted");
    expect(flagged.code).toBe(2);
    expect(commits(fx.kb)).toBe(1);
  });

  test("placement is by scope, and a computed path is refused", () => {
    const fx = registered();
    for (const scope of [
      "docs/kb/adr",
      "../outside",
      "/abs/path",
      "billing/exports.md",
      "Billing",
      "projects/x",
      "a//b",
    ]) {
      const sent = kb(
        fx,
        fx.project,
        "publish",
        "document",
        "--kind",
        "concept",
        "--scope",
        scope,
        "--id",
        "x",
        "--title",
        "X",
        "--file",
        page(fx),
      );
      expect(sent.code).toBe(1);
      expect(refusal(sent).code).toBe("kb.scope-is-a-path");
    }
    const traversal = kb(
      fx,
      fx.project,
      "publish",
      "document",
      "--kind",
      "concept",
      "--scope",
      "project",
      "--id",
      "../../escape",
      "--title",
      "X",
      "--file",
      page(fx),
    );
    expect(refusal(traversal).code).toBe("kb.id-invalid");
    expect(commits(fx.kb)).toBe(0);
    expect(readdirSync(fx.kb).filter((name) => name !== ".git")).toEqual([]);
  });

  test("an unchanged republish writes nothing twice", () => {
    const fx = registered();
    const file = page(fx);
    const first = published(publishPage(fx, fx.project, file, "--run", "run-1"));
    const second = published(publishPage(fx, fx.project, file, "--run", "run-1"));
    expect(second.effect).toBe("none");
    expect(second.ref).toBe(first.ref);
    expect(second.revision).toBe(first.revision);
    expect(commits(fx.kb)).toBe(1);
  });

  test("a republish under another run reports the stored key and run", () => {
    const fx = registered();
    const file = page(fx);
    const first = published(publishPage(fx, fx.project, file, "--run", "run-1"));
    const second = published(publishPage(fx, fx.project, file, "--run", "run-2"));
    expect(first.run).toBe("run-1");
    expect(second.effect).toBe("none");
    expect(second.run).toBe("run-1");
    expect(second.idempotency_key).toBe(first.idempotency_key);
    expect(commits(fx.kb)).toBe(1);
  });

  test("a page file that begins with blank lines reads back as what was published", () => {
    const fx = registered();
    const sent = publishPage(fx, fx.project, page(fx, `\n\n${PAGE}`));
    expect(sent.code).toBe(0);
    expect(published(sent).effect).toBe("published");
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents[0]?.body).toBe(PAGE);
    expect(read.documents[0]?.content_hash).toBe(published(sent).content_hash);
    expect(published(publishPage(fx, fx.project, page(fx))).effect).toBe("none");
    expect(commits(fx.kb)).toBe(1);
  });

  test("a CRLF page reads back as published where the knowledgebase normalizes line endings", () => {
    const fx = registered();
    git(fx.kb, "config", "core.autocrlf", "input");
    const sent = publishPage(fx, fx.project, page(fx, PAGE.replaceAll("\n", "\r\n")));
    expect(sent.code).toBe(0);
    expect(published(sent).effect).toBe("published");
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents[0]?.body).toBe(PAGE);
    expect(read.documents[0]?.content_hash).toBe(published(sent).content_hash);
    expect(published(publishPage(fx, fx.project, page(fx))).effect).toBe("none");
    expect(commits(fx.kb)).toBe(1);
  });

  test("a page whose lines end in repeated carriage returns reads back as published", () => {
    const fx = registered();
    const sent = publishPage(fx, fx.project, page(fx, PAGE.replaceAll("\n", "\r\r\n")));
    expect(sent.code).toBe(0);
    expect(published(sent).effect).toBe("published");
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents[0]?.body).toBe(PAGE);
    expect(read.documents[0]?.content_hash).toBe(published(sent).content_hash);
    expect(commits(fx.kb)).toBe(1);
  });

  test("changed content under a reused record is refused, not overwritten", () => {
    const fx = registered();
    publishPage(fx, fx.project, page(fx));
    const sent = publishPage(fx, fx.project, page(fx, "# Queue the exports\n\nActually, do not.\n"));
    expect(sent.code).toBe(1);
    expect(refusal(sent).code).toBe("kb.changed-under-reused-record");
    expect(commits(fx.kb)).toBe(1);
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents[0]?.body).toBe(PAGE);
  });

  test("a publish leaves unrelated uncommitted work in the knowledgebase alone", () => {
    const fx = registered();
    writeFileSync(join(fx.kb, "notes.md"), "a human's draft\n");
    expect(publishPage(fx, fx.project, page(fx)).code).toBe(0);
    expect(git(fx.kb, "status", "--porcelain").trim()).toBe("?? notes.md");
    expect(git(fx.kb, "show", "--name-only", "--format=", "HEAD").trim()).toBe(
      "projects/example-project/documents/billing/exports/adr/queue-the-exports.md",
    );
  });
});

describe("readContext", () => {
  test("resolves most specific first and reports what it searched", () => {
    const fx = registered();
    const publishAt = (scope: string, id: string): Run =>
      kb(
        fx,
        fx.project,
        "publish",
        "document",
        "--kind",
        "concept",
        "--scope",
        scope,
        "--id",
        id,
        "--title",
        id,
        "--file",
        page(fx),
      );
    expect(publishAt("project", "whole").code).toBe(0);
    expect(publishAt("billing", "area").code).toBe(0);
    expect(publishAt("billing/exports", "component").code).toBe(0);
    expect(publishAt("search", "elsewhere").code).toBe(0);
    const read = readResult(kb(fx, fx.project, "read", "--kind", "concept,adr", "--scope", "billing/exports"));
    expect(read.status).toBe("complete");
    expect(read.documents.map((doc) => doc.scope)).toEqual(["billing/exports", "billing", "project"]);
    expect(read.coverage.scopes).toEqual(["billing/exports", "billing", "project"]);
    expect(read.coverage.kinds).toEqual(["concept", "adr"]);
    expect(read.coverage.run_artifact_links).toBe("not-selected");
  });

  test("reads what is committed, never an uncommitted file in the checkout", () => {
    const fx = registered();
    publishPage(fx, fx.project, page(fx));
    const dir = join(fx.kb, "projects", "example-project", "documents", "billing", "exports", "adr");
    writeFileSync(join(dir, "draft.md"), "---\nref: doc:x\n---\n\nnot committed\n");
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents).toHaveLength(1);
  });

  test("a committed page that is not a record is named, not silently dropped", () => {
    const fx = registered();
    publishPage(fx, fx.project, page(fx));
    const rel = "projects/example-project/documents/billing/exports/adr/hand-written.md";
    writeFileSync(join(fx.kb, rel), "# no header\n");
    git(fx.kb, "add", "--", rel);
    git(fx.kb, "commit", "-q", "-m", "hand-written");
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents).toHaveLength(1);
    expect(read.coverage.unreadable).toEqual([rel]);
  });

  test("a committed page whose file name is not ASCII is named too", () => {
    const fx = registered();
    publishPage(fx, fx.project, page(fx));
    const rel = "projects/example-project/documents/billing/exports/adr/decisión.md";
    writeFileSync(join(fx.kb, rel), "# no header\n");
    git(fx.kb, "add", "--", rel);
    git(fx.kb, "commit", "-q", "-m", "hand-written");
    const read = readResult(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "billing/exports"));
    expect(read.documents).toHaveLength(1);
    expect(read.coverage.unreadable).toEqual([rel]);
  });

  test("an unknown kind or a path as scope is refused", () => {
    const fx = registered();
    expect(refusal(kb(fx, fx.project, "read", "--kind", "runbook", "--scope", "project")).code).toBe("kb.kind-unknown");
    expect(refusal(kb(fx, fx.project, "read", "--kind", "adr", "--scope", "docs/adr")).code).toBe("kb.scope-is-a-path");
  });
});

describe("publishArtifact, run-artifact placement", () => {
  test("a schema-valid artifact is stored under its run and linked from a record", () => {
    const fx = registered();
    const doc = published(publishPage(fx, fx.project, page(fx)));
    const sent = kb(
      fx,
      fx.project,
      "publish",
      "artifact",
      "--file",
      decision(fx),
      "--run",
      "example-run-1",
      "--link",
      doc.ref,
    );
    expect(sent.code).toBe(0);
    expect(published(sent).ref).toBe("run:example-run-1/decision/example-decision-1");
    const stored: unknown = JSON.parse(
      git(fx.kb, "show", "HEAD:projects/example-project/runs/example-run-1/decision/example-decision-1.json"),
    );
    expect(stored).toMatchObject({ record: { links: [doc.ref], content_hash: published(sent).content_hash } });
    expect(git(fx.project, "status", "--porcelain")).toBe("");
  });

  test("an artifact failing its own schema is refused before any write", () => {
    const fx = registered();
    const bad = decision(fx, {}, ["question"]);
    const sent = kb(fx, fx.project, "publish", "artifact", "--file", bad, "--run", "example-run-1");
    expect(sent.code).toBe(1);
    expect(refusal(sent).code).toBe("kb.artifact-invalid");
    expect(commits(fx.kb)).toBe(0);
    expect(readdirSync(fx.kb).filter((name) => name !== ".git")).toEqual([]);
  });

  test("an artifact of another project or another run is refused", () => {
    const fx = registered();
    const elsewhere = decision(fx, { project: { ...decisionExample.project, id: "another-project" } });
    const foreign = kb(fx, fx.project, "publish", "artifact", "--file", elsewhere, "--run", "example-run-1");
    expect(refusal(foreign).code).toBe("kb.project-mismatch");
    const otherRun = kb(fx, fx.project, "publish", "artifact", "--file", decision(fx), "--run", "run-2");
    expect(refusal(otherRun).code).toBe("kb.run-mismatch");
    expect(commits(fx.kb)).toBe(0);
  });

  test("a link that names no record is refused", () => {
    const fx = registered();
    for (const link of [
      "doc:billing/adr/never-published",
      "projects/example-project/documents/adr/x.md",
      "run:../../x/y",
    ]) {
      const sent = kb(
        fx,
        fx.project,
        "publish",
        "artifact",
        "--file",
        decision(fx),
        "--run",
        "example-run-1",
        "--link",
        link,
      );
      expect(refusal(sent).code).toBe("kb.link-unresolved");
    }
    expect(commits(fx.kb)).toBe(0);
  });

  test("an unchanged republish is a no-op and a changed one is refused", () => {
    const fx = registered();
    const args = ["publish", "artifact", "--run", "example-run-1", "--file"];
    expect(published(kb(fx, fx.project, ...args, decision(fx))).effect).toBe("published");
    expect(published(kb(fx, fx.project, ...args, decision(fx))).effect).toBe("none");
    const changed = decision(fx, {
      question: "A different question under the same id, which is a different artifact?",
    });
    expect(refusal(kb(fx, fx.project, ...args, changed)).code).toBe("kb.changed-under-reused-record");
    expect(commits(fx.kb)).toBe(1);
  });

  test("a republish that changes the links is refused, not reported as stored", () => {
    const fx = registered();
    const doc = published(publishPage(fx, fx.project, page(fx)));
    const args = ["publish", "artifact", "--run", "example-run-1", "--file"];
    expect(published(kb(fx, fx.project, ...args, decision(fx))).effect).toBe("published");
    const relinked = kb(fx, fx.project, ...args, decision(fx), "--link", doc.ref);
    expect(relinked.code).toBe(1);
    expect(refusal(relinked).code).toBe("kb.changed-under-reused-record");
    expect(commits(fx.kb)).toBe(2);
    const stored: unknown = JSON.parse(
      git(fx.kb, "show", "HEAD:projects/example-project/runs/example-run-1/decision/example-decision-1.json"),
    );
    expect(stored).toMatchObject({ record: { links: [] } });
  });

  test("an approved copy published after its draft is stored on the same record", () => {
    const fx = registered();
    const { approvals, ...unapproved } = charterExample;
    const write = (name: string, artifact: object): string => {
      const file = join(fx.scratch, name);
      writeFileSync(file, JSON.stringify(artifact));
      return file;
    };
    const args = ["publish", "artifact", "--run", "example-run-1", "--file"];
    const path = "projects/example-project/runs/example-run-1/charter/example-charter-1.json";
    const stored = (): unknown => JSON.parse(git(fx.kb, "show", `HEAD:${path}`));

    const draft = published(kb(fx, fx.project, ...args, write("draft.json", unapproved)));
    expect(draft.effect).toBe("published");
    expect(stored()).not.toHaveProperty("artifact.approvals");

    const approved = published(kb(fx, fx.project, ...args, write("approved.json", charterExample)));
    expect(approved.effect).toBe("published");
    expect(approved.ref).toBe(draft.ref);
    expect(approved.content_hash).toBe(draft.content_hash);
    expect(approved.revision).not.toBe(draft.revision);
    expect(approved.revision).toBe(git(fx.kb, "rev-parse", "HEAD").trim());
    expect(commits(fx.kb)).toBe(2);
    expect(stored()).toMatchObject({
      record: { ref: approved.ref, content_hash: approved.content_hash, idempotency_key: approved.idempotency_key },
      artifact: { approvals },
    });
    expect(approved.run).toBe("example-run-1");

    const again = published(kb(fx, fx.project, ...args, write("approved.json", charterExample)));
    expect(again.effect).toBe("none");
    expect(again.revision).toBe(approved.revision);
    const lateDraft = published(kb(fx, fx.project, ...args, write("draft.json", unapproved)));
    expect(lateDraft.effect).toBe("none");
    expect(stored()).toMatchObject({ artifact: { approvals } });
    expect(commits(fx.kb)).toBe(2);
    expect(git(fx.kb, "status", "--porcelain")).toBe("");
  });

  test("every envelope schema can be carried", () => {
    expect(ARTIFACT_SCHEMA_IDS.toSorted()).toEqual(commonSchema.$defs.schema_id.enum.toSorted());
  });
});

describe("the five operations no backend carries", () => {
  test("each is refused, bound or not, and writes nothing", () => {
    const fx = registered();
    for (const command of [
      "record-decision",
      "link-code-evidence",
      "request-impact-analysis",
      "link-pull-requests",
      "propose-lesson",
    ]) {
      const run = kb(fx, fx.project, command, "--anything", "at-all");
      expect(run.code).toBe(1);
      expect(refusal(run).code).toBe("kb.operation-not-carried");
    }
    expect(commits(fx.kb)).toBe(0);
    expect(git(fx.project, "status", "--porcelain")).toBe("");
  });
});

describe("the backends this package carries", () => {
  test("every backend document has a schema and a compiled validator, and nothing else does", () => {
    const documented = readdirSync(join(REPO, BACKENDS_DIR))
      .filter((name) => name.endsWith(".md"))
      .map((name) => basename(name, ".md"))
      .toSorted();
    const schemas = readdirSync(join(REPO, BACKEND_SCHEMAS_DIR))
      .map((name) => name.replace(/\.schema\.json$/, ""))
      .toSorted();
    expect(documented).toEqual([...BACKEND_VALIDATORS.keys()].toSorted());
    expect(schemas).toEqual(documented);
  });

  test("this repository's own binding is valid", () => {
    expect(loadKbBinding(REPO).issues).toEqual([]);
    expect(loadKbBinding(REPO).binding?.project).toBe("agent-kit");
  });
});

describe("ak doctor", () => {
  test("reports the binding as absent, bound or broken", () => {
    const unbound = fixture(null);
    expect(checkKnowledgebase(unbound.project, unbound.registry).level).toBe("WARN");
    const fx = fixture();
    expect(checkKnowledgebase(fx.project, fx.registry).level).toBe("WARN");
    kb(fx, fx.project, "register", "fixture-kb", fx.kb);
    expect(checkKnowledgebase(fx.project, fx.registry).level).toBe("PASS");
    writeFileSync(fx.registry, "{");
    expect(checkKnowledgebase(fx.project, fx.registry).level).toBe("FAIL");
  });
});
