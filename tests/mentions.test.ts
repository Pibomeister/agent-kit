/**
 * A skill names the seats, protocols and schemas its workflow loads by their root path or, for a
 * role, by its catalog id. The packager used to copy only what a relative link reached, so an
 * installed `doc-review` named `doc-review/coherence` and `super-build` named
 * `roles/implementer/ROLE.md` and `schemas/ticket.schema.json`, and the bundle carried no protocol,
 * policy or adapter contract a skill named that way. These hold the packager to carrying every one
 * and the bundle check to failing when one is left out.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog/load.ts";
import { planAll } from "../src/packaging/build.ts";
import { codeSpans, linkMentions, mentionResolver, rootPathOf, schemaRefs } from "../src/packaging/mentions.ts";
import { checkBundleLinks, unlinkedMentions } from "../src/validation/links.ts";
import { makeTree } from "./helpers/tree.ts";

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
skills:
  - id: alpha
    status: authored
    invocation: M
    profiles: [core]
protocols:
  - id: tdd
    status: authored
  - id: phase-operations
    status: authored
roles:
  - id: implementer
    status: authored
  - id: doc-review/coherence
    status: authored
  - id: doc-review/unwritten
    status: contract
schemas:
  - id: ticket
    status: authored
  - id: common
    status: authored
profiles:
  - id: core
    status: authored
`;

const HEAD = "---\nname: alpha\ndescription: d\n---\n";

const SHARED = {
  "protocols/tdd/PROTOCOL.md": "# TDD\n\nRecord each run as `schemas/ticket.schema.json` says.\n",
  "roles/implementer/ROLE.md": "# Implementer\n",
  "protocols/phase-operations/PROTOCOL.md": "# Phase operations\n",
  "roles/doc-review/coherence/ROLE.md": "# Coherence\n",
  "schemas/ticket.schema.json": '{ "$ref": "common.schema.json#/$defs/envelope" }\n',
  "schemas/common.schema.json": '{ "$defs": { "envelope": {} } }\n',
};

function ctxFor(body: string, extra: Record<string, string> = {}) {
  const root = makeTree({ "catalog.yaml": CATALOG, "skills/alpha/SKILL.md": `${HEAD}${body}`, ...SHARED, ...extra });
  const { catalog } = loadCatalog(root);
  if (catalog === null) throw new Error("fixture has no catalog");
  return { root, catalog };
}

function claudeBundle(body: string, extra: Record<string, string> = {}): Map<string, string> {
  const plan = planAll(ctxFor(body, extra), { hosts: ["claude-code"] })[0];
  if (plan === undefined) throw new Error("no plan");
  return new Map([...plan.files].map(([path, file]) => [path, file.contents]));
}

describe("the packager carries what a skill names", () => {
  test("a seat, protocol and schema named by root path travel, and their names become links", () => {
    const bundle = claudeBundle(
      "Seat `roles/implementer/ROLE.md`, work `protocols/tdd/PROTOCOL.md`, read `schemas/ticket.schema.json`.\n",
    );
    for (const path of ["roles/implementer/ROLE.md", "protocols/tdd/PROTOCOL.md", "schemas/ticket.schema.json"])
      expect(bundle.has(`references/shared/${path}`)).toBe(true);
    expect(bundle.get("skills/alpha/SKILL.md")).toContain(
      "[`roles/implementer/ROLE.md`](../../references/shared/roles/implementer/ROLE.md)",
    );
  });

  test("a role named by its catalog id travels as its ROLE.md", () => {
    const bundle = claudeBundle("`doc-review/coherence` reaches every document.\n");
    expect(bundle.has("references/shared/roles/doc-review/coherence/ROLE.md")).toBe(true);
    expect(bundle.get("skills/alpha/SKILL.md")).toContain(
      "[`doc-review/coherence`](../../references/shared/roles/doc-review/coherence/ROLE.md) reaches",
    );
  });

  test("what a carried file names travels too, and a schema brings the schemas it $refs", () => {
    const bundle = claudeBundle("Work `protocols/tdd/PROTOCOL.md`.\n");
    expect(bundle.has("references/shared/schemas/ticket.schema.json")).toBe(true);
    expect(bundle.has("references/shared/schemas/common.schema.json")).toBe(true);
    expect(bundle.get("references/shared/protocols/tdd/PROTOCOL.md")).toContain(
      "[`schemas/ticket.schema.json`](../../schemas/ticket.schema.json)",
    );
  });

  test("a protocol cited as protocol `<id>` travels as its PROTOCOL.md, and a bare id does not", () => {
    const bundle = claudeBundle("Started under protocol `phase-operations`; see also `tdd`.\n");
    expect(bundle.has("references/shared/protocols/phase-operations/PROTOCOL.md")).toBe(true);
    expect(bundle.get("skills/alpha/SKILL.md")).toContain(
      "protocol [`phase-operations`](../../references/shared/protocols/phase-operations/PROTOCOL.md);",
    );
    expect(bundle.get("skills/alpha/SKILL.md")).toContain("see also `tdd`.");
  });

  test("brackets written inside code spans do not hide a mention between them as link text", () => {
    const body = "Brackets: `[`, then protocol `phase-operations`, then `](`.\n";
    const bundle = claudeBundle(body);
    expect(bundle.has("references/shared/protocols/phase-operations/PROTOCOL.md")).toBe(true);
    expect(bundle.get("skills/alpha/SKILL.md")).toContain(
      "protocol [`phase-operations`](../../references/shared/protocols/phase-operations/PROTOCOL.md), then `](`.",
    );
    expect(checkBundleLinks(ctxFor(body), {})).toEqual([]);
  });

  test("brackets inside double-backtick code spans do not hide a mention between them as link text", () => {
    const body = "Brackets: ``[``, then protocol `phase-operations`, then ``](``.\n";
    expect(claudeBundle(body).get("skills/alpha/SKILL.md")).toContain(
      "protocol [`phase-operations`](../../references/shared/protocols/phase-operations/PROTOCOL.md), then ``](``.",
    );
    expect(checkBundleLinks(ctxFor(body), {})).toEqual([]);
  });

  test("a skill's own references/ file is linked where the skill carries it and passes the bundle check", () => {
    const body = "The checklist is in `references/checklist.md`.\n";
    const extra = { "skills/alpha/references/checklist.md": "# Checklist\n" };
    expect(claudeBundle(body, extra).get("skills/alpha/SKILL.md")).toContain(
      "[`references/checklist.md`](./references/checklist.md)",
    );
    expect(checkBundleLinks(ctxFor(body, extra), {})).toEqual([]);
  });

  test("an id written before the word protocol travels as its PROTOCOL.md and passes the bundle check", () => {
    const body = "Test-first under the `tdd` protocol.\n";
    expect(claudeBundle(body).get("skills/alpha/SKILL.md")).toContain(
      "the [`tdd`](../../references/shared/protocols/tdd/PROTOCOL.md) protocol.",
    );
    expect(checkBundleLinks(ctxFor(body), {})).toEqual([]);
  });

  // `roles/../../x` would copy a file from outside the repository into dist/.
  test("a mention that climbs out of its tree copies nothing and fails the bundle check", () => {
    const body =
      "See `roles/../secret.txt`, `roles/../.git/config`, `roles/../../outside.txt` and `schemas/./ticket.schema.json`.\n";
    const bundle = claudeBundle(body, { "secret.txt": "secret\n", ".git/config": "[core]\n" });
    expect([...bundle.keys()].filter((path) => /secret|outside|\.git|\/\.\//.test(path))).toEqual([]);
    expect(bundle.get("skills/alpha/SKILL.md")).toContain(body.trim());
    const issues = checkBundleLinks(ctxFor(body), {}).filter(
      (i) => i.rule === "links.mention-not-bundled" && i.file.includes("claude-code"),
    );
    expect(issues.map((i) => i.message.split("'")[1])).toEqual([
      "roles/../secret.txt",
      "roles/../.git/config",
      "roles/../../outside.txt",
      "schemas/./ticket.schema.json",
    ]);
  });

  test("a policy and an adapter contract named by root path travel, and their names become links", () => {
    const extra = {
      "policies/limits.yaml": "limits: {}\n",
      "adapters/runner-contract/CONTRACT.md": "# Runner contract\n",
    };
    const body = "Caps in `policies/limits.yaml`; the runner per `adapters/runner-contract/CONTRACT.md`.\n";
    const bundle = claudeBundle(body, extra);
    expect(bundle.get("references/shared/policies/limits.yaml")).toBe("limits: {}\n");
    expect(bundle.get("references/shared/adapters/runner-contract/CONTRACT.md")).toBe("# Runner contract\n");
    const skill = bundle.get("skills/alpha/SKILL.md");
    expect(skill).toContain("[`policies/limits.yaml`](../../references/shared/policies/limits.yaml)");
    expect(skill).toContain(
      "[`adapters/runner-contract/CONTRACT.md`](../../references/shared/adapters/runner-contract/CONTRACT.md)",
    );
    expect(checkBundleLinks(ctxFor(body, extra), {})).toEqual([]);
  });

  test("a mention that reaches outside the tree through a symlink copies nothing and fails the bundle check", () => {
    const outside = makeTree({ "secret.md": "OUTSIDE\n" });
    const body = "Read `references/evil-link.md`.\n";
    const ctx = ctxFor(body);
    mkdirSync(join(ctx.root, "references"));
    symlinkSync(join(outside, "secret.md"), join(ctx.root, "references", "evil-link.md"));
    const plan = planAll(ctx, { hosts: ["claude-code"] })[0];
    if (plan === undefined) throw new Error("no plan");
    expect([...plan.files.values()].some((file) => file.contents.includes("OUTSIDE"))).toBe(false);
    expect(plan.files.get("skills/alpha/SKILL.md")?.contents).toContain(body.trim());
    const issues = checkBundleLinks(ctx, { hosts: ["claude-code"] });
    expect(issues.map((i) => `${i.rule} ${i.message.split("'")[1]}`)).toEqual([
      "links.mention-not-bundled references/evil-link.md",
    ]);
  });

  test("a $ref sibling that leaves its tree through a symlink is not carried, and the bundle check fails", () => {
    const outside = makeTree({ "secret.json": '{ "OUTSIDE": true }\n' });
    const ctx = ctxFor("Fill `schemas/x.schema.json`.\n", { "schemas/x.schema.json": '{ "$ref": "evil.json" }\n' });
    symlinkSync(join(outside, "secret.json"), join(ctx.root, "schemas", "evil.json"));
    const plan = planAll(ctx, { hosts: ["claude-code"] })[0];
    if (plan === undefined) throw new Error("no plan");
    expect(plan.files.has("references/shared/schemas/x.schema.json")).toBe(true);
    expect([...plan.files.values()].some((file) => file.contents.includes("OUTSIDE"))).toBe(false);
    const issues = checkBundleLinks(ctx, { hosts: ["claude-code"] });
    expect(issues.map((i) => `${i.rule} ${i.file}`)).toContain(
      "links.broken-bundle dist/claude-code/references/shared/schemas/x.schema.json",
    );
  });

  test("a protocol body cited by id that leaves its tree through a symlink is not carried, and the bundle check fails", () => {
    const outside = makeTree({ "secret.md": "OUTSIDE\n" });
    const ctx = ctxFor("Under protocol `phase-operations`.\n");
    const body = join(ctx.root, "protocols", "phase-operations", "PROTOCOL.md");
    rmSync(body);
    symlinkSync(join(outside, "secret.md"), body);
    const plan = planAll(ctx, { hosts: ["claude-code"] })[0];
    if (plan === undefined) throw new Error("no plan");
    expect([...plan.files.values()].some((file) => file.contents.includes("OUTSIDE"))).toBe(false);
    const issues = checkBundleLinks(ctx, { hosts: ["claude-code"] });
    expect(issues.map((i) => `${i.rule} ${i.file}`)).toContain(
      "links.broken-bundle dist/claude-code/skills/alpha/SKILL.md",
    );
  });

  test("a skill asset, declared role, schema or role-linked template that leaves its tree through a symlink is not copied", () => {
    const outside = makeTree({ "secret.md": "OUTSIDE\n", "secret.json": '{ "OUTSIDE": true }\n' });
    const ctx = ctxFor("Plain.\n", {
      "skills/alpha/references/ok.md": "# Ok\n",
      "roles/implementer/ROLE.md": "# Implementer\n\nFill [the form](../../templates/evil.md).\n",
    });
    mkdirSync(join(ctx.root, "templates"));
    symlinkSync(join(outside, "secret.md"), join(ctx.root, "templates", "evil.md"));
    symlinkSync(join(outside, "secret.md"), join(ctx.root, "skills", "alpha", "references", "evil.md"));
    const coherence = join(ctx.root, "roles", "doc-review", "coherence", "ROLE.md");
    rmSync(coherence);
    symlinkSync(join(outside, "secret.md"), coherence);
    symlinkSync(join(outside, "secret.json"), join(ctx.root, "schemas", "evil.schema.json"));
    const plan = planAll(ctx, { hosts: ["claude-code"] })[0];
    if (plan === undefined) throw new Error("no plan");
    expect([...plan.files.values()].some((file) => file.contents.includes("OUTSIDE"))).toBe(false);
    for (const path of ["skills/alpha/references/ok.md", "roles/implementer/ROLE.md", "schemas/ticket.schema.json"])
      expect(plan.files.has(path)).toBe(true);
  });

  test("a tree reached through a symlinked root still carries what a skill names", () => {
    const { root, catalog } = ctxFor("Work `protocols/tdd/PROTOCOL.md`.\n");
    const link = join(makeTree({}), "linked-root");
    symlinkSync(root, link);
    const plan = planAll({ root: link, catalog }, { hosts: ["claude-code"] })[0];
    expect(plan?.files.has("references/shared/protocols/tdd/PROTOCOL.md")).toBe(true);
  });

  test("a tree that is itself a link to another checkout's tree still carries what a skill names", () => {
    const { root, catalog } = ctxFor("Work `protocols/tdd/PROTOCOL.md`.\n");
    const farm = makeTree({});
    for (const entry of ["catalog.yaml", "skills", "protocols", "roles", "schemas"])
      symlinkSync(join(root, entry), join(farm, entry));
    const plan = planAll({ root: farm, catalog }, { hosts: ["claude-code"] })[0];
    expect(plan?.files.has("references/shared/protocols/tdd/PROTOCOL.md")).toBe(true);
  });

  test("an eval case is copied verbatim and is not held to linking what it names", () => {
    const evalCase = "Prompt: seat `implementer` and fill `schemas/user.json`.\n";
    const extra = { "evals/alpha/cases/seat.md": evalCase };
    expect(claudeBundle("Body.\n", extra).get("evals/alpha/cases/seat.md")).toBe(evalCase);
    expect(checkBundleLinks(ctxFor("Body.\n", extra), { hosts: ["claude-code"] })).toEqual([]);
  });

  test("an absolute path is not a mention and copies nothing", () => {
    const body = "Never `/etc/passwd` nor `/roles/implementer/ROLE.md`.\n";
    const bundle = claudeBundle(body);
    expect([...bundle.keys()].some((path) => path.includes("passwd"))).toBe(false);
    expect(bundle.has("references/shared/roles/implementer/ROLE.md")).toBe(false);
    expect(bundle.get("skills/alpha/SKILL.md")).toContain(body.trim());
  });

  test("a declared copy keeps its source bytes and is not held to linking its mentions", () => {
    const role = "# Implementer\n\nFollow `protocols/tdd/PROTOCOL.md`.\n";
    const extra = { "roles/implementer/ROLE.md": role };
    const bundle = claudeBundle("Seat `implementer`.\n", extra);
    expect(bundle.get("roles/implementer/ROLE.md")).toBe(role);
    expect(bundle.get("references/shared/roles/implementer/ROLE.md")).toContain(
      "[`protocols/tdd/PROTOCOL.md`](../../protocols/tdd/PROTOCOL.md)",
    );
    expect(checkBundleLinks(ctxFor("Seat `implementer`.\n", extra), {})).toEqual([]);
  });

  test("the bundle check passes once everything named is carried", () => {
    expect(checkBundleLinks(ctxFor("Seat `implementer`, then `roles/implementer/ROLE.md`.\n"), {})).toEqual([]);
  });

  test("a root path to a file the tree does not have fails the bundle check, naming the file and line", () => {
    const body = "Intro.\n\nRead `schemas/missing.schema.json`.\n";
    const issues = checkBundleLinks(ctxFor(body), {});
    const issue = issues.find((i) => i.rule === "links.mention-not-bundled" && i.file.includes("claude-code"));
    expect(issue?.severity).toBe("error");
    expect(issue?.file).toBe("dist/claude-code/skills/alpha/SKILL.md");
    expect(issue?.message).toContain("schemas/missing.schema.json");
    const lines = claudeBundle(body).get("skills/alpha/SKILL.md")?.split("\n") ?? [];
    expect(lines[(issue?.line ?? 0) - 1]).toBe("Read `schemas/missing.schema.json`.");
  });
});

describe("what counts as naming a file", () => {
  const resolve = mentionResolver({
    isFile: (path) =>
      path === "schemas/common.schema.json" ||
      path === "roles/implementer/ROLE.md" ||
      path === "skills/a/references/checklist.md",
    bodyOf: (dir) => (dir === "roles/implementer" ? "roles/implementer/ROLE.md" : null),
    roleBody: (id) => (id === "implementer" ? "roles/implementer/ROLE.md" : null),
    protocolBody: (id) => (id === "tdd" ? "protocols/tdd/PROTOCOL.md" : null),
  });
  const link = (text: string) =>
    linkMentions("skills/a/SKILL.md", "skills/a/SKILL.md", text, resolve, (source) => `references/shared/${source}`);

  test("an anchor that could close the link target is not a mention", () => {
    const text = "`roles/implementer/ROLE.md#a)[x](javascript:alert(1)`";
    expect(rootPathOf(text.slice(1, -1))).toBeNull();
    expect(link(text)).toEqual({ text, dependencies: [] });
  });

  test("an anchor stays on the link", () => {
    expect(link("`schemas/common.schema.json#/$defs/escalation`").text).toBe(
      "[`schemas/common.schema.json#/$defs/escalation`](../../references/shared/schemas/common.schema.json#/$defs/escalation)",
    );
  });

  test("a path the body's own directory holds names that file, not a root one", () => {
    expect(link("`references/checklist.md`").text).toBe(
      "[`references/checklist.md`](../../references/shared/skills/a/references/checklist.md)",
    );
  });

  test("an id written before the word protocol is cited as one", () => {
    expect(link("under the `tdd` protocol.").dependencies).toEqual(["protocols/tdd/PROTOCOL.md"]);
    expect(link("the `tdd` protocols").dependencies).toEqual([]);
  });

  test("a catalog entry's directory names its body", () => {
    expect(link("`roles/implementer`").dependencies).toEqual(["roles/implementer/ROLE.md"]);
  });

  test("fenced blocks, frontmatter and an existing link are left as written", () => {
    const text = "---\nnote: `implementer`\n---\n```\n`implementer`\n```\n[`implementer`](x.md)\n";
    expect(link(text)).toEqual({ text, dependencies: [] });
  });

  test("a span inside longer link text is not linked again", () => {
    const text = "see [`roles/implementer/ROLE.md` §7](../x.md#7) and [a `implementer` b](y.md)";
    expect(link(text)).toEqual({ text, dependencies: [] });
    expect(codeSpans(text).map((s) => s.linked)).toEqual([true, true]);
  });

  test("project paths, placeholders and globs are not this package's files", () => {
    for (const span of ["docs/plans/x.md", "AGENTS.md", "schemas/*.schema.json", "roles/<id>/ROLE.md", "roles/"])
      expect(rootPathOf(span)).toBeNull();
  });

  test("code spans are read outside fences, with their lines", () => {
    expect(codeSpans("a `x`\n```\n`y`\n```\n[`z`](z.md) protocol `tdd`\n")).toEqual([
      { span: "x", line: 1, linked: false, protocolCited: false },
      { span: "z", line: 5, linked: true, protocolCited: false },
      { span: "tdd", line: 5, linked: false, protocolCited: true },
    ]);
  });

  test("the bundle check flags a role or a cited protocol left plain, and an uncited id is prose", () => {
    const ids = { roles: new Set(["implementer"]), protocols: new Set(["tdd"]) };
    const issues = unlinkedMentions("claude-code", "skills/a/SKILL.md", "`implementer`, protocol `tdd`, `tdd`.\n", ids);
    expect(issues.map((i) => i.message.split(" is named")[0])).toEqual(["Role 'implementer'", "Protocol 'tdd'"]);
  });

  test("a schema's relative $ref siblings are its dependencies, and URLs are not", () => {
    const text =
      '{"a":{"$ref":"common.schema.json#/$defs/x"},"b":{"$ref":"https://x/y.json"},"c":{"$ref":"#/$defs/z"}}';
    expect(schemaRefs("schemas/ticket.schema.json", text)).toEqual(["schemas/common.schema.json"]);
    expect(schemaRefs("schemas/ticket.schema.json", '{"$ref":"../.env"},{"$ref":"./x.json"}')).toEqual([]);
  });
});
