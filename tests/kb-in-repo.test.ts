import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import { runKb } from "../src/kb/cli.ts";
import findingExample from "../templates/finding.example.json" with { type: "json" };
import { publishRunArtifact } from "../src/kb/local-git.ts";
import { eventsFromKbFindings, ingest } from "../src/learn/review/ingest.ts";
import { reviewLedger } from "../src/learn/review/ledger.ts";
import { checkKnowledgebase } from "../src/maintenance/cli.ts";
import { processScratch } from "./helpers/process-tmp.ts";
import { testContext } from "./learn/helpers.ts";

/**
 * The read-only `in-repo` backend (adapters/knowledgebase/backends/in-repo.md):
 * a project's own committed wiki read in place, at the merge-base of the
 * checkout's HEAD and the binding's base branch, with every publish skipped as
 * a coverage limit and nothing written anywhere.
 */

const BINDING = `backend: in-repo
project: example-project
locator:
  knowledgebase: example-wiki
  path: docs/wiki
  base: main
  kinds:
    concept: concepts
    system: systems
    adr: decisions
`;

function git(dir: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** The pages merged on the base branch, by path under the wiki. */
const BASE_PAGES = {
  "concepts/auth-model.md":
    "---\ntitle: Auth Model\ntags: [auth]\ncategory: concept\n---\n\n## What it is\n\nTokens live in cookies.\n",
  "concepts/index.md": "# Concepts\n",
  "systems/queue.md": "# Queue\n\nJobs run on a queue.\n",
  "systems/cross-repo/sync.md": "# Sync\n\nRepositories sync nightly.\n",
  "decisions/use-postgres.md": "---\nstatus: Accepted\n---\n\n# Use Postgres\n\nWe store data in Postgres.\n",
  "decisions/inline-status.md": "# Inline status\n\n**Status:** Accepted\n\nBody.\n",
  "decisions/superseded-one.md": "# Superseded one\n\n## Status\n\nSuperseded by [[use-postgres]]\n",
  "decisions/draft-one.md": "---\nstatus: draft\n---\n\n# Draft one\n",
  "decisions/no-status.md": "# No status\n\nNothing declared.\n",
  "decisions/Bad_Name.md": "# Bad\n",
  "decisions/nested/use-postgres.md": "# Duplicate stem\n",
  "auto/generated.md": "# Generated\n",
  "patterns/unmapped.md": "# Not mapped\n",
} satisfies Record<string, string>;

interface Fixture {
  /** The project folder: the directory holding ak.kb.yaml. */
  project: string;
  /** The git top level, which is the project folder unless the fixture nests it. */
  top: string;
  registry: string;
  scratch: string;
}

/**
 * A project whose wiki is merged on `main`, checked out on a work branch.
 * `nested` puts the project folder (and the binding) one directory below the git top.
 */
function fixture(options: { binding?: string; nested?: boolean; pages?: Record<string, string> } = {}): Fixture {
  const scratch = processScratch("ak-kb-in-repo-");
  const top = join(scratch, "repo");
  mkdirSync(top, { recursive: true });
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "fixture");
  git(top, "config", "user.email", "fixture@example.invalid");
  git(top, "config", "commit.gpgsign", "false");
  git(top, "config", "core.hooksPath", "/dev/null");
  const project = options.nested === true ? join(top, "apps", "site") : top;
  write(project, "ak.kb.yaml", options.binding ?? BINDING);
  for (const [path, text] of Object.entries(options.pages ?? BASE_PAGES)) write(project, join("docs/wiki", path), text);
  git(top, "add", "-A");
  git(top, "commit", "-q", "-m", "base");
  git(top, "checkout", "-q", "-b", "work");
  return { project: realpathSync(project), top: realpathSync(top), registry: join(scratch, "registry.json"), scratch };
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function kb(fx: Fixture, ...argv: string[]): Run {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const code = runKb(argv, { cwd: fx.project, io, registry: fx.registry });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

interface ReadDoc {
  ref: string;
  kind: string;
  scope: string;
  id: string;
  title: string;
  status: string;
  declared_status: string | null;
  content_hash: string;
  revision: string;
  body: string;
}

interface ReadResult {
  status: string;
  documents: ReadDoc[];
  coverage: { unreadable: string[] };
}

interface SkipResult {
  status: string;
  capability: string;
  code: string;
}

const ajv = new Ajv2020({ strict: false });
const isRead = ajv.compile<ReadResult>({ type: "object", required: ["status", "documents", "coverage"] });
const isSkip = ajv.compile<SkipResult>({ type: "object", required: ["status", "capability", "code"] });

interface Read {
  run: Run;
  result: ReadResult;
}

function read(fx: Fixture, kinds = "concept,system,adr", scope = "project"): Read {
  const run = kb(fx, "read", "--kind", kinds, "--scope", scope);
  const value: unknown = JSON.parse(run.out);
  if (!isRead(value)) throw new Error(`not a read result: ${run.out}`);
  return { run, result: value };
}

function expectSkipped(fx: Fixture, run: Run): void {
  expect(run.code).toBe(3);
  const value: unknown = JSON.parse(run.out);
  if (!isSkip(value)) throw new Error(`not a skipped result: ${run.out}`);
  expect(value).toMatchObject({ status: "skipped", capability: "kb-write", code: "kb.read-only" });
  expect(git(fx.top, "status", "--porcelain")).toBe("");
}

function expectMissing(run: Run): void {
  expect(run.code).toBe(3);
  expect(run.out).toContain("kb.in-repo-missing");
}

function byId(docs: ReadDoc[], id: string): ReadDoc | undefined {
  return docs.find((doc) => doc.id === id);
}

describe("ak kb check on an in-repo binding", () => {
  test("is bound and read-only, naming the backend, knowledgebase, path, base and project", () => {
    const fx = fixture();
    const run = kb(fx, "check");
    expect(run.code).toBe(0);
    for (const part of ["in-repo", "example-wiki", "docs/wiki", "main", "example-project", "read-only"]) {
      expect(run.out).toContain(part);
    }
  });

  test("needs no registration and leaves the registry untouched", () => {
    const fx = fixture();
    expect(kb(fx, "check").code).toBe(0);
    expect(readdirSync(fx.scratch)).not.toContain("registry.json");
  });
});

describe("readContext on an in-repo binding", () => {
  test("returns exactly the mapped pages, with mapped subdirectories and without index.md or unmapped directories", () => {
    const fx = fixture();
    const { run, result } = read(fx);
    expect(run.code).toBe(0);
    expect(result.status).toBe("complete");
    const ids = result.documents.map((doc) => `${doc.kind}/${doc.id}`).toSorted();
    expect(ids).toEqual(
      [
        "adr/draft-one",
        "adr/inline-status",
        "adr/no-status",
        "adr/superseded-one",
        "concept/auth-model",
        "system/queue",
        "system/sync",
      ].toSorted(),
    );
  });

  test("maps a page to ref, scope, title, body, hash and revision", () => {
    const fx = fixture();
    const { result } = read(fx);
    const page = byId(result.documents, "auth-model");
    expect(page?.ref).toBe("doc:project/concept/auth-model");
    expect(page?.scope).toBe("project");
    expect(page?.title).toBe("Auth Model");
    expect(page?.body).toBe("## What it is\n\nTokens live in cookies.\n");
    expect(page?.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(page?.revision).toBe(git(fx.top, "rev-parse", "main").trim());
    expect(byId(result.documents, "queue")?.title).toBe("Queue");
  });

  test("maps status into the closed set and keeps the declared word", () => {
    const fx = fixture();
    const { result } = read(fx, "adr");
    const status = (id: string) => [byId(result.documents, id)?.status, byId(result.documents, id)?.declared_status];
    expect(status("inline-status")).toEqual(["accepted", "accepted"]);
    expect(status("superseded-one")).toEqual(["superseded", "superseded"]);
    expect(status("draft-one")).toEqual(["unreviewed", "draft"]);
    expect(status("no-status")).toEqual(["unreviewed", null]);
  });

  test("front matter status Accepted reads as accepted", () => {
    const fx = fixture({ pages: { "decisions/use-postgres.md": BASE_PAGES["decisions/use-postgres.md"] ?? "" } });
    const page = byId(read(fx, "adr").result.documents, "use-postgres");
    expect(page?.status).toBe("accepted");
    expect(page?.declared_status).toBe("accepted");
  });

  test("names a non-kebab stem and every copy of a duplicate stem as unreadable, and returns none of them", () => {
    const fx = fixture();
    const { result } = read(fx, "adr");
    expect(result.coverage.unreadable.toSorted()).toEqual(
      [
        "docs/wiki/decisions/Bad_Name.md",
        "docs/wiki/decisions/nested/use-postgres.md",
        "docs/wiki/decisions/use-postgres.md",
      ].toSorted(),
    );
    expect(byId(result.documents, "use-postgres")).toBeUndefined();
  });

  test("a header that is not closed, does not parse or gives a list or map reads as absent; a scalar is text", () => {
    const fx = fixture({
      pages: {
        "concepts/fine.md": "---\ntitle: Fine\n---\n\nBody.\n",
        "concepts/unterminated.md": "---\ntitle: Never closed\n\nBody.\n",
        "concepts/list-title.md": "---\ntitle: [a, b]\n---\n\nBody.\n",
        "concepts/map-status.md": "---\nstatus:\n  value: accepted\n---\n\nBody.\n",
        "concepts/number-title.md": "---\ntitle: 42\n---\n\nBody.\n",
        "concepts/colon-title.md": "---\ntitle: System: Chat\n---\n\n# Chat\n\n## Status\n\nAccepted\n",
      },
    });
    const { result } = read(fx, "concept");
    expect(result.coverage.unreadable).toEqual([]);
    const titles = Object.fromEntries(result.documents.map((doc) => [doc.id, doc.title]));
    expect(titles).toEqual({
      "colon-title": "Chat",
      fine: "Fine",
      "list-title": "list-title",
      "map-status": "map-status",
      "number-title": "42",
      unterminated: "unterminated",
    });
    expect(byId(result.documents, "map-status")?.declared_status).toBeNull();
    expect(byId(result.documents, "colon-title")?.status).toBe("accepted");
  });

  test("a page git cannot read fails the read rather than vanishing from it", () => {
    const fx = fixture();
    const blob = git(fx.top, "rev-parse", "main:docs/wiki/concepts/auth-model.md").trim();
    rmSync(join(fx.top, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const run = kb(fx, "read", "--kind", "concept", "--scope", "project");
    expect(run.code).toBe(1);
    expect(run.out).toContain('"status": "failed"');
    expect(run.out).toContain("kb.unreadable");
  });

  test("a component scope returns the project pages with no note on stderr", () => {
    const fx = fixture();
    const { run, result } = read(fx, "concept", "billing/exports");
    expect(run.code).toBe(0);
    expect(result.documents.map((doc) => doc.id)).toEqual(["auth-model"]);
    expect(run.err).toBe("");
  });

  test("a scope that is a path, or an unknown kind, is refused", () => {
    const fx = fixture();
    expect(kb(fx, "read", "--kind", "concept", "--scope", "docs/wiki.md").code).toBe(1);
    expect(kb(fx, "read", "--kind", "glossary", "--scope", "project").code).toBe(1);
  });
});

describe("a branch's own wiki commits are not knowledge until merged", () => {
  test("a page edited on the branch reads as on the base, a page added on it is absent, and so is an uncommitted file", () => {
    const fx = fixture();
    write(
      fx.project,
      "docs/wiki/decisions/no-status.md",
      "---\nstatus: accepted\n---\n\n# No status\n\nEdited on the branch.\n",
    );
    write(fx.project, "docs/wiki/decisions/branch-only.md", "---\nstatus: accepted\n---\n\n# Branch only\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "branch edits");
    write(fx.project, "docs/wiki/concepts/uncommitted.md", "# Uncommitted\n");
    const { result } = read(fx);
    const edited = byId(result.documents, "no-status");
    expect(edited?.status).toBe("unreviewed");
    expect(edited?.body).toBe("# No status\n\nNothing declared.\n");
    expect(byId(result.documents, "branch-only")).toBeUndefined();
    expect(byId(result.documents, "uncommitted")).toBeUndefined();
  });

  test("the remote-tracking base is preferred over a local branch of the same name", () => {
    const fx = fixture();
    const mainTip = git(fx.top, "rev-parse", "main").trim();
    git(fx.top, "update-ref", "refs/remotes/origin/main", mainTip);
    git(fx.top, "checkout", "-q", "main");
    write(fx.project, "docs/wiki/concepts/local-only.md", "# Local only\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "local main moves ahead");
    git(fx.top, "checkout", "-q", "work");
    git(fx.top, "merge", "-q", "--ff-only", "main");
    expect(byId(read(fx, "concept").result.documents, "local-only")).toBeUndefined();
  });
});

describe("publish to an in-repo binding is skipped, and nothing is written anywhere", () => {
  test("document and artifact placements, with and without trail attempts", () => {
    const fx = fixture();
    const head = git(fx.top, "rev-parse", "HEAD").trim();
    const page = join(fx.scratch, "page.md");
    writeFileSync(page, "# A page\n");
    const artifact = join(fx.scratch, "artifact.json");
    writeFileSync(artifact, "{}");
    const attempts = join(fx.scratch, "attempts");
    mkdirSync(attempts);
    expectSkipped(
      fx,
      kb(fx, "publish", "document", "--kind", "adr", "--scope", "project", "--id", "x", "--title", "X", "--file", page),
    );
    expectSkipped(fx, kb(fx, "publish", "artifact", "--file", artifact, "--run", "r1"));
    expectSkipped(fx, kb(fx, "publish", "artifact", "--file", artifact, "--run", "r1", "--trail-attempts", attempts));
    expect(readdirSync(attempts)).toEqual([]);
    expect(git(fx.top, "rev-parse", "HEAD").trim()).toBe(head);
  });
});

describe("a missing in-repo knowledgebase is a coverage limit", () => {
  test("a HEAD with no commit yet is a missing knowledgebase", () => {
    const fx = fixture();
    git(fx.top, "checkout", "-q", "--orphan", "unborn");
    expectMissing(kb(fx, "check"));
  });

  test("a path absent at the read revision", () => {
    const fx = fixture({ binding: BINDING.replace("path: docs/wiki", "path: docs/nowhere") });
    expectMissing(kb(fx, "check"));
    expectMissing(kb(fx, "read", "--kind", "concept", "--scope", "project"));
    const page = join(fx.scratch, "page.md");
    writeFileSync(page, "# A page\n");
    expectMissing(
      kb(fx, "publish", "document", "--kind", "adr", "--scope", "project", "--id", "x", "--title", "X", "--file", page),
    );
  });

  test("a base branch that does not resolve", () => {
    const fx = fixture({ binding: BINDING.replace("base: main", "base: trunk") });
    expectMissing(kb(fx, "check"));
    expectMissing(kb(fx, "read", "--kind", "concept", "--scope", "project"));
    const page = join(fx.scratch, "page.md");
    writeFileSync(page, "# A page\n");
    expectMissing(
      kb(fx, "publish", "document", "--kind", "adr", "--scope", "project", "--id", "x", "--title", "X", "--file", page),
    );
  });

  test("ak doctor warns with the cause, and passes a resolvable binding as read-only", () => {
    const missing = fixture({ binding: BINDING.replace("path: docs/wiki", "path: docs/nowhere") });
    const warn = checkKnowledgebase(missing.project, missing.registry);
    expect(warn.level).toBe("WARN");
    expect(JSON.stringify(warn)).toContain("kb.in-repo-missing");
    expect(JSON.stringify(warn)).not.toContain("no ak.kb.yaml");
    const fx = fixture();
    const pass = checkKnowledgebase(fx.project, fx.registry);
    expect(pass.level).toBe("PASS");
    expect(JSON.stringify(pass)).toContain("read-only");
  });
});

/** Where git keeps `rev`'s object loose in a fixture that has never been packed. */
function looseObject(fx: Fixture, rev: string): string {
  const sha = git(fx.top, "rev-parse", rev).trim();
  return join(fx.top, ".git", "objects", sha.slice(0, 2), sha.slice(2));
}

describe("git failing is failed, not a coverage limit", () => {
  test("git merge-base failing on a lost ancestor fails check", () => {
    const fx = fixture();
    const ancestor = looseObject(fx, "main");
    write(fx.project, "README.md", "work\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "work moves");
    git(fx.top, "checkout", "-q", "main");
    write(fx.project, "OTHER.md", "main\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "main moves");
    git(fx.top, "checkout", "-q", "work");
    rmSync(ancestor);
    const run = kb(fx, "check");
    expect(run.code).toBe(1);
    expect(run.out).toContain("kb.unreadable");
    expect(run.out).toContain("git merge-base failed");
  });

  test("a HEAD whose commit object is lost fails check rather than reading as unborn", () => {
    const fx = fixture();
    write(fx.project, "README.md", "work\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "work moves");
    rmSync(looseObject(fx, "HEAD"));
    const run = kb(fx, "check");
    expect(run.code).toBe(1);
    expect(run.out).toContain("kb.unreadable");
  });

  test("a base whose tip object is lost fails check rather than reading as unresolved", () => {
    const fx = fixture();
    git(fx.top, "checkout", "-q", "main");
    write(fx.project, "OTHER.md", "main\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "main moves");
    git(fx.top, "checkout", "-q", "work");
    rmSync(looseObject(fx, "main"));
    const run = kb(fx, "check");
    expect(run.code).toBe(1);
    expect(run.out).toContain("kb.unreadable");
  });

  test("git ls-tree failing on a lost directory tree fails check", () => {
    const fx = fixture();
    rmSync(looseObject(fx, "main:docs"));
    const run = kb(fx, "check");
    expect(run.code).toBe(1);
    expect(run.out).toContain("kb.unreadable");
  });

  test("git log failing on lost history fails the read while check still binds", () => {
    const fx = fixture();
    const first = looseObject(fx, "main");
    write(fx.project, "README.md", "second\n");
    git(fx.top, "add", "-A");
    git(fx.top, "commit", "-q", "-m", "second");
    git(fx.top, "branch", "-f", "main", "HEAD");
    rmSync(first);
    expect(kb(fx, "check").code).toBe(0);
    const run = kb(fx, "read", "--kind", "concept", "--scope", "project");
    expect(run.code).toBe(1);
    expect(run.out).toContain("could not walk");
  });
});

describe("an in-repo binding that is not valid is refused", () => {
  const cases = {
    "an absolute path": BINDING.replace("path: docs/wiki", "path: /docs/wiki"),
    "a path with ..": BINDING.replace("path: docs/wiki", "path: ../wiki"),
    "a path containing .. inside a segment": BINDING.replace("path: docs/wiki", "path: docs/a..b"),
    "a path that is .": BINDING.replace("path: docs/wiki", "path: ."),
    "a path with a backslash": BINDING.replace("path: docs/wiki", "path: docs\\\\wiki"),
    "an unknown kind": BINDING.replace("concept: concepts", "glossary: concepts"),
    "an empty kind map": BINDING.replace(/ {2}kinds:\n(?: {4}.*\n)+/, "  kinds: {}\n"),
    "a kind directory that is .": BINDING.replace("concept: concepts", "concept: ."),
    "equal kind directories": BINDING.replace("system: systems", "system: concepts"),
    "nested kind directories": BINDING.replace("adr: decisions", "adr: concepts/decisions"),
    "a missing base": BINDING.replace("  base: main\n", ""),
    "a local-git locator carrying a map":
      "backend: local-git\nproject: example-project\nlocator:\n  knowledgebase:\n    id: central\n",
  } satisfies Record<string, string>;
  for (const [name, binding] of Object.entries(cases)) {
    test(name, () => {
      const fx = fixture({ binding });
      const run = kb(fx, "check");
      expect(run.code).toBe(1);
      expect(run.out).toContain("kb.binding-invalid");
    });
  }
});

describe("a project folder below the git top", () => {
  test("reads its pages from the path relative to the folder holding ak.kb.yaml", () => {
    const fx = fixture({ nested: true });
    expect(kb(fx, "check").code).toBe(0);
    const { run, result } = read(fx, "concept");
    expect(run.code).toBe(0);
    expect(result.documents.map((doc) => doc.id)).toEqual(["auth-model"]);
    expect(readFileSync(join(fx.project, "ak.kb.yaml"), "utf8")).toBe(BINDING);
  });
});

describe("the learning review's knowledgebase-findings source", () => {
  const options = { skipGithub: true, skipMem: true };

  test("an in-repo binding carries no findings and reads no local-git path under the project", () => {
    const fx = fixture();
    // A finding the local-git reader would ingest, committed where it would look under this project.
    const stored = publishRunArtifact(
      {
        root: fx.top,
        knowledgebase: "example-wiki",
        binding: { backend: "local-git", project: "example-project", locator: {} },
      },
      JSON.stringify({ ...findingExample, project: { id: "example-project", repo: "acme/example" } }),
      findingExample.run_id,
      [],
    );
    expect(stored.status).toBe("complete");
    expect(eventsFromKbFindings(fx.top, "example-project")).toHaveLength(1);
    const ctx = testContext({ env: { AK_KB_REGISTRY: fx.registry } });
    const result = ingest(ctx, reviewLedger(ctx.config, fx.project), fx.project, options);
    expect(result.events.filter((event) => event.source === "kb-finding")).toEqual([]);
    expect(result.unavailable).not.toContain("kb-finding");
  });

  test("a missing in-repo knowledgebase records the source unavailable with its cause", () => {
    const fx = fixture({ binding: BINDING.replace("path: docs/wiki", "path: docs/nowhere") });
    const ctx = testContext({ env: { AK_KB_REGISTRY: fx.registry } });
    const result = ingest(ctx, reviewLedger(ctx.config, fx.project), fx.project, options);
    expect(result.unavailable).toContain("kb-finding");
    expect(ctx.err.join("\n")).toContain("'docs/nowhere' is not a directory");
  });
});
