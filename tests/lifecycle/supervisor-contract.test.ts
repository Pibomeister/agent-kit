/**
 * The supervisor contract's two file shapes (docs/decisions/0014-unattended-lifecycle-policy.md, amendment of
 * 2026-11-11; adapters/supervisor/CONTRACT.md): the JSON schemas and the gate's validators accept and reject the
 * same shape fixtures, the canonical identity pattern is pinned, and the examples in the two documents pass the
 * gate's own validators and the gate's start check unchanged.
 *
 * The schemas cover shape only. Containment, readability, name equality, reviewer-author distinctness and head
 * ancestry live in the gate, so no fixture here depends on them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import * as lib from "../../src/lifecycle/unattended.ts";
import { runCli } from "../../src/cli.ts";
import { makeTree } from "../helpers/tree.ts";

const ROOT = join(import.meta.dir, "../..");
const CONTRACT = "agent-kit/supervisor-contract@1";
const OBLIGATIONS = [
  "launch-and-watch",
  "validation-gate",
  "independent-review",
  "seat-separation",
  "head-bound-evidence",
  "disclosure",
] as const;
/** The pattern the attestation schema carries for a canonical identity, and the function that agrees with it. */
const IDENTITY_PATTERN = "^[^\\s/\\p{Lu}\\p{Lt}]+/[^\\s\\p{Lu}\\p{Lt}]+$";

type Value = lib.Json | undefined;

function schemaOf(name: string): ValidateFunction {
  const text = readFileSync(join(ROOT, "schemas", `${name}.schema.json`), "utf8");
  return new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(text));
}

const obligations = (): { [key: string]: string } =>
  Object.fromEntries(OBLIGATIONS.map((key) => [key, `how the supervisor meets ${key}`]));

const declaration = (over: { [key: string]: lib.Json } = {}): lib.JsonObject => ({
  contract: CONTRACT,
  supervisor: "firstmate",
  obligations: obligations(),
  ...over,
});
const withObligation = (key: string, value: lib.Json | undefined): lib.JsonObject => {
  const copy: lib.JsonObject = { ...obligations() };
  if (value === undefined) Reflect.deleteProperty(copy, key);
  else copy[key] = value;
  return declaration({ obligations: copy });
};
const without = (value: lib.JsonObject, key: string): lib.JsonObject => {
  const copy = { ...value };
  Reflect.deleteProperty(copy, key);
  return copy;
};

const HEAD = "a".repeat(40);
const VALIDATION: lib.JsonObject = { result: "pass", ref: "validation run 41 on the supervisor's runner" };
const REVIEW: lib.JsonObject = {
  result: "approve",
  reviewer: "vendor-b/model-x",
  authors: ["vendor-a/model-y"],
  ref: "review report 12 in the supervisor's store",
};
const isObj = (v: Value): v is lib.JsonObject => Object.prototype.toString.call(v) === "[object Object]";
const nameOf = (v: Value): string => {
  const name = isObj(v) ? v.supervisor : undefined;
  return Array.isArray(name) || isObj(name) ? "" : String(name ?? "");
};
const attestation = (over: { [key: string]: lib.Json } = {}): lib.JsonObject => ({
  contract: CONTRACT,
  supervisor: "firstmate",
  head: HEAD,
  pull_request: "https://example.invalid/acme/widget/pull/7",
  validation: VALIDATION,
  review: REVIEW,
  ...over,
});
const review = (over: { [key: string]: lib.Json }): lib.JsonObject => attestation({ review: { ...REVIEW, ...over } });
const validation = (over: { [key: string]: lib.Json }): lib.JsonObject =>
  attestation({ validation: { ...VALIDATION, ...over } });

interface Fixture {
  name: string;
  value: Value;
  valid: boolean;
}

const DECLARATIONS: Fixture[] = [
  { name: "a complete declaration", value: declaration(), valid: true },
  { name: "an unknown top-level key", value: declaration({ extra: "x" }), valid: false },
  { name: "a missing contract", value: without(declaration(), "contract"), valid: false },
  {
    name: "another contract version",
    value: declaration({ contract: "agent-kit/supervisor-contract@2" }),
    valid: false,
  },
  { name: "a non-string contract", value: declaration({ contract: 1 }), valid: false },
  { name: "a missing supervisor", value: without(declaration(), "supervisor"), valid: false },
  { name: "an empty supervisor", value: declaration({ supervisor: "" }), valid: false },
  { name: "a whitespace-only supervisor", value: declaration({ supervisor: "  " }), valid: false },
  { name: "a supervisor with surrounding whitespace", value: declaration({ supervisor: " firstmate " }), valid: false },
  { name: "a supervisor with a line feed", value: declaration({ supervisor: "first\nmate" }), valid: false },
  { name: "a supervisor with an escape character", value: declaration({ supervisor: "first\x1bmate" }), valid: false },
  { name: "a supervisor with a delete character", value: declaration({ supervisor: "first\x7fmate" }), valid: false },
  { name: "a non-string supervisor", value: declaration({ supervisor: ["firstmate"] }), valid: false },
  {
    name: "a supervisor with inner spaces and a comma",
    value: declaration({ supervisor: "firstmate, crew 3" }),
    valid: true,
  },
  { name: "missing obligations", value: without(declaration(), "obligations"), valid: false },
  { name: "obligations as a list", value: declaration({ obligations: [] }), valid: false },
  { name: "obligations as text", value: declaration({ obligations: "all" }), valid: false },
  ...OBLIGATIONS.map((key) => ({
    name: `obligation ${key} missing`,
    value: withObligation(key, undefined),
    valid: false,
  })),
  { name: "an unknown obligation", value: withObligation("deploys-for-you", "yes"), valid: false },
  { name: "an empty obligation text", value: withObligation("disclosure", ""), valid: false },
  { name: "a whitespace-only obligation text", value: withObligation("disclosure", "   "), valid: false },
  { name: "an obligation text with a line feed", value: withObligation("disclosure", "one\ntwo"), valid: false },
  { name: "an obligation text with a carriage return", value: withObligation("disclosure", "one\rtwo"), valid: false },
  { name: "an obligation text with a line separator", value: withObligation("disclosure", "one two"), valid: false },
  { name: "a non-string obligation text", value: withObligation("disclosure", 7), valid: false },
  { name: "an array at the top", value: [], valid: false },
  { name: "text at the top", value: "declaration", valid: false },
  { name: "null at the top", value: null, valid: false },
];

/** The nested keys the attestation schema requires, section by section; a test below pins the lists to the schema. */
const NESTED_REQUIRED = [
  ["validation", VALIDATION, ["result", "ref"]],
  ["review", REVIEW, ["result", "reviewer", "authors", "ref"]],
] as const;

const ATTESTATIONS: Fixture[] = [
  { name: "a complete attestation", value: attestation(), valid: true },
  { name: "no pull request reference", value: without(attestation(), "pull_request"), valid: true },
  { name: "an empty pull request reference", value: attestation({ pull_request: "" }), valid: false },
  { name: "a multi-line pull request reference", value: attestation({ pull_request: "a\nb" }), valid: false },
  { name: "a non-string pull request reference", value: attestation({ pull_request: 7 }), valid: false },
  { name: "an unknown top-level key", value: attestation({ merged: true }), valid: false },
  { name: "an unknown validation key", value: validation({ passed_at: "now" }), valid: false },
  { name: "an unknown review key", value: review({ model: "x" }), valid: false },
  { name: "a wrong contract", value: attestation({ contract: "agent-kit/supervisor-contract@2" }), valid: false },
  { name: "a missing contract", value: without(attestation(), "contract"), valid: false },
  { name: "a missing supervisor", value: without(attestation(), "supervisor"), valid: false },
  { name: "an upper-case head", value: attestation({ head: "A".repeat(40) }), valid: false },
  { name: "a short head", value: attestation({ head: "a".repeat(39) }), valid: false },
  { name: "a long head", value: attestation({ head: "a".repeat(41) }), valid: false },
  { name: "a non-hex head", value: attestation({ head: "g".repeat(40) }), valid: false },
  { name: "a missing head", value: without(attestation(), "head"), valid: false },
  { name: "a missing validation", value: without(attestation(), "validation"), valid: false },
  { name: "a missing review", value: without(attestation(), "review"), valid: false },
  { name: "a failed validation", value: validation({ result: "fail" }), valid: false },
  { name: "a missing validation result", value: attestation({ validation: { ref: "r" } }), valid: false },
  { name: "an empty validation ref", value: validation({ ref: "" }), valid: false },
  { name: "a multi-line validation ref", value: validation({ ref: "a\nb" }), valid: false },
  { name: "a rejected review", value: review({ result: "reject" }), valid: false },
  { name: "an empty review ref", value: review({ ref: "" }), valid: false },
  { name: "a multi-line review ref", value: review({ ref: "a\nb" }), valid: false },
  { name: "an upper-case reviewer", value: review({ reviewer: "Vendor-B/Model-X" }), valid: false },
  { name: "a reviewer with surrounding whitespace", value: review({ reviewer: " vendor-b/model-x" }), valid: false },
  { name: "a reviewer with no slash", value: review({ reviewer: "model-x" }), valid: false },
  { name: "a reviewer with no provider", value: review({ reviewer: "/model-x" }), valid: false },
  { name: "a reviewer with no model", value: review({ reviewer: "vendor-b/" }), valid: false },
  { name: "a reviewer with whitespace inside", value: review({ reviewer: "vendor-b/model x" }), valid: false },
  { name: "a reviewer with a provider space", value: review({ reviewer: "vendor b/model-x" }), valid: false },
  { name: "a reviewer with a nested model path", value: review({ reviewer: "vendor-b/team/model-x" }), valid: true },
  { name: "a non-ASCII upper-case reviewer", value: review({ reviewer: "vendor-b/modèl-É" }), valid: false },
  { name: "a non-string reviewer", value: review({ reviewer: 5 }), valid: false },
  { name: "no authors", value: review({ authors: [] }), valid: false },
  { name: "authors as text", value: review({ authors: "vendor-a/model-y" }), valid: false },
  {
    name: "a non-canonical author",
    value: review({ authors: ["vendor-a/model-y", "Vendor-A/Model-Z"] }),
    valid: false,
  },
  {
    name: "several canonical authors",
    value: review({ authors: ["vendor-a/model-y", "vendor-c/model-z"] }),
    valid: true,
  },
  { name: "a reviewer that is also an author", value: review({ authors: ["vendor-b/model-x"] }), valid: true },
  ...NESTED_REQUIRED.flatMap(([section, whole, keys]) =>
    keys.map((key) => ({
      name: `${section}.${key} missing`,
      value: attestation({ [section]: without(whole, key) }),
      valid: false,
    })),
  ),
  { name: "an array at the top", value: [], valid: false },
  { name: "null at the top", value: null, valid: false },
];

describe("the nested required keys", () => {
  test.each(NESTED_REQUIRED)("%s lists exactly the keys the attestation schema requires", (section, _whole, keys) => {
    const schema = lib.parseJson(readFileSync(join(ROOT, "schemas", "supervisor-attestation.schema.json"), "utf8"));
    const properties = isObj(schema) ? schema.properties : undefined;
    const nested = isObj(properties) ? properties[section] : undefined;
    const required = isObj(nested) ? nested.required : undefined;
    expect(required).toEqual([...keys]);
  });
});

describe("the contract's names and constants", () => {
  test("the library exports the contract constants and the closed obligation list", () => {
    expect(lib.CONTRACT).toBe(CONTRACT);
    expect(lib.DECLARATION_ENV).toBe("AK_LIFECYCLE_SUPERVISOR_DECLARATION");
    expect([...lib.OBLIGATIONS]).toEqual([...OBLIGATIONS]);
  });

  test("the disclosure is the one sentence of the contract, naming the supervisor", () => {
    expect(lib.unattendedDisclosure("firstmate")).toBe(
      "Unattended lifecycle policy (supervisor: firstmate, in place of a human): no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, the supervisor attests its validation gate and independent review at the head, which agent-kit checks but cannot authenticate, and agent-kit does not merge: whoever the human authorized merges.",
    );
  });
});

describe.each([
  ["supervisor-declaration", DECLARATIONS, lib.declarationFailures],
  ["supervisor-attestation", ATTESTATIONS, lib.attestationFailures],
] as const)("the %s schema and the gate's validator", (name, fixtures, failures) => {
  test.each(fixtures)("agree on $name", ({ value, valid }) => {
    expect(schemaOf(name)(value)).toBe(valid);
    // A declaration's name equality is the gate's check, so each declaration fixture is judged under its own name.
    const named = nameOf(value);
    const own = name === "supervisor-declaration" && named !== "" ? named : "firstmate";
    const found = failures(value, own);
    expect(found.length === 0).toBe(valid);
    for (const message of found) expect(message).not.toBe("");
  });

  test("the schema is closed and reaches no further than shape", () => {
    const text = readFileSync(join(ROOT, "schemas", `${name}.schema.json`), "utf8");
    const schema = lib.parseJson(text);
    expect(isObj(schema) ? schema.$id : undefined).toBe(`https://agent-kit.local/schemas/${name}.schema.json`);
    expect(isObj(schema) ? schema.additionalProperties : undefined).toBe(false);
  });
});

const failureText = (value: Value, kind: "declaration" | "attestation") =>
  (kind === "declaration" ? lib.declarationFailures : lib.attestationFailures)(value, "firstmate").join("\n");

describe("what only the gate checks", () => {
  test("a declaration naming another supervisor than the one the run names is refused by the validator", () => {
    const found = lib.declarationFailures(declaration({ supervisor: "other-crew" }), "firstmate");
    expect(found.join("\n")).toContain("supervisor");
    expect(found.join("\n")).toContain("other-crew");
    expect(schemaOf("supervisor-declaration")(declaration({ supervisor: "other-crew" }))).toBe(true);
  });

  test("an attestation naming another supervisor is refused by the validator and passes the schema", () => {
    const found = lib.attestationFailures(attestation({ supervisor: "other-crew" }), "firstmate");
    expect(found.join("\n")).toContain("supervisor");
    expect(schemaOf("supervisor-attestation")(attestation({ supervisor: "other-crew" }))).toBe(true);
  });

  test("every failure message names the failed key", () => {
    expect(failureText(declaration({ contract: "x" }), "declaration")).toContain("contract");
    expect(failureText(declaration({ extra: 1 }), "declaration")).toContain("extra");
    expect(failureText(withObligation("validation-gate", undefined), "declaration")).toContain("validation-gate");
    expect(failureText(withObligation("nope", "x"), "declaration")).toContain("nope");
    expect(failureText(withObligation("disclosure", "a\nb"), "declaration")).toContain("disclosure");
    expect(failureText(attestation({ head: "xyz" }), "attestation")).toContain("head");
    expect(failureText(attestation({ merged: true }), "attestation")).toContain("merged");
    expect(failureText(validation({ result: "fail" }), "attestation")).toContain("validation.result");
    expect(failureText(review({ result: "reject" }), "attestation")).toContain("review.result");
    expect(failureText(review({ authors: [] }), "attestation")).toContain("review.authors");
    expect(failureText(attestation({ pull_request: "" }), "attestation")).toContain("pull_request");
  });

  test("a non-canonical identity is refused naming it, never normalised", () => {
    const reviewer = lib.attestationFailures(review({ reviewer: " Vendor-B/Model-X" }), "firstmate");
    expect(reviewer).toHaveLength(1);
    expect(reviewer[0]).toContain(" Vendor-B/Model-X");
    expect(reviewer[0]).toContain("review.reviewer");
    const author = lib.attestationFailures(review({ authors: ["vendor-a/model-y", "Vendor-A/Model-Z"] }), "firstmate");
    expect(author).toHaveLength(1);
    expect(author[0]).toContain("Vendor-A/Model-Z");
    expect(author[0]).toContain("review.authors");
  });
});

describe("the canonical identity", () => {
  const CASES: [string, boolean][] = [
    ["vendor-b/model-x", true],
    ["vendor-b/team/model-x", true],
    ["vendor/model:1.5-preview", true],
    ["Vendor-B/model-x", false],
    ["vendor-b/Model-X", false],
    [" vendor-b/model-x", false],
    ["vendor-b/model-x ", false],
    ["vendor-b/model-x\n", false],
    ["vendor-b", false],
    ["/model-x", false],
    ["vendor-b/", false],
    ["vendor b/model-x", false],
    ["vendor-b/model x", false],
    ["vendor-b/mo\tdel", false],
    ["", false],
    ["vendor-b/modèl-É", false],
  ];

  test.each(CASES)("isCanonicalIdentity(%j) is %p", (id, expected) => {
    expect(lib.isCanonicalIdentity(id)).toBe(expected);
  });

  test("the attestation schema carries the pinned pattern, and the pattern agrees with the function", () => {
    const text = readFileSync(join(ROOT, "schemas", "supervisor-attestation.schema.json"), "utf8");
    expect(text).toContain(JSON.stringify(IDENTITY_PATTERN).slice(1, -1));
    const pattern = new RegExp(IDENTITY_PATTERN, "u");
    for (const [id] of CASES) expect(pattern.test(id)).toBe(lib.isCanonicalIdentity(id));
  });
});

const sentence = (name = "firstmate") => lib.unattendedDisclosure(name);

describe("the disclosure sentence in a body", () => {
  test.each([
    ["on its own line", `Change.\n\n${sentence()}\n`],
    ["inside a longer paragraph", `Change. ${sentence()} More text.`],
    ["after a closed fence", `\`\`\`\ncode\n\`\`\`\n${sentence()}\n`],
    ["after a closed tilde fence", `~~~~\ncode\n~~~~\n${sentence()}\n`],
    ["after a comment", `<!-- note -->\n${sentence()}`],
    [
      "after a fenced html block that holds an unclosed comment opener",
      `\`\`\`html\n<!-- template\n\`\`\`\n${sentence()}\n`,
    ],
    ["after a paragraph that quotes the comment opener in inline code", `Strips \`<!--\` comments.\n\n${sentence()}\n`],
    ["after an inline empty comment", `Inline \`<!-->\` before it.\n\n${sentence()}\n`],
    ["after a line that is inline code and not a fence", `\`\`\`npm test\`\`\`\n\n${sentence()}\n`],
    [
      "after an HTML block line closes a comment that a block quote left open",
      `> <!--\n\n<!-- end -->\n\n${sentence()}\n`,
    ],
    [
      "after an HTML block that opens with an empty comment, when either reading of the block shows it",
      `<!--->\n\n${sentence()}\n`,
    ],
  ])("is carried %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(true);
  });

  test.each([
    ["only inside a backtick fence", `\`\`\`\n${sentence()}\n\`\`\`\n`],
    ["only inside a tilde fence", `~~~\n${sentence()}\n~~~\n`],
    ["inside a fence that is never closed", `text\n\`\`\`\n${sentence()}\n`],
    ["only inside an HTML comment", `<!--\n${sentence()}\n-->`],
    ["inside a comment on one line", `Text <!-- ${sentence()} --> more`],
    ["for a longer supervisor name", `Text ${sentence("firstmate-two")}`],
    ["for another supervisor", `Text ${sentence("other")}`],
    ["wrapped across lines", sentence().replace("in place of", "in place\nof")],
    ["with a doubled space", sentence().replace("no human", "no  human")],
    ["with its final period removed", sentence().slice(0, -1)],
    ["absent", "Change."],
    ["inside a comment that is never closed", `Change.\n\n<!--\n${sentence()}\n`],
    ["inside a backtick fence that holds a tilde line", `\`\`\`\n~~~\n${sentence()}\n\`\`\`\n`],
    ["inside a fence whose would-be closer has an info string", `\`\`\`\n\`\`\`js\n${sentence()}\n\`\`\`\n`],
    [
      "only inside a real fence after a line that is inline code",
      `\`\`\`js\`\`\`\n\ntext\n\n\`\`\`\n${sentence()}\n\`\`\`\n`,
    ],
    ["only inside a backtick fence in a block quote", `> \`\`\`\n> ${sentence()}\n> \`\`\`\n`],
    ["only inside a tilde fence in a block quote", `> ~~~\n> ${sentence()}\n> ~~~\n`],
    ["only inside a backtick fence in a list item", `- \`\`\`\n  ${sentence()}\n  \`\`\`\n`],
    ["only inside a backtick fence in a numbered list item", `1. \`\`\`\n   ${sentence()}\n   \`\`\`\n`],
    [
      "in a comment after a fence line indented four columns",
      `Summary.\n\n    \`\`\`\n<!--\n    \`\`\`\n${sentence()}\n-->\n`,
    ],
    [
      "in a comment that an unquoted opener starts after a block-quote fence",
      `Summary.\n\n> \`\`\`\n<!--\n> \`\`\`\n${sentence()}\n-->\n`,
    ],
    [
      "in a comment that an unindented opener starts after a list-item fence",
      `Summary.\n\n- \`\`\`\n<!--\n- \`\`\`\n${sentence()}\n-->\n`,
    ],
    ["in a top-level fence past a quoted fence line", `Summary.\n\n\`\`\`\n> \`\`\`\n${sentence()}\n\`\`\`\n`],
    ["only in indented code", `Summary.\n\n    ${sentence()}\n`],
    ["after a comment that a block quote leaves open in the page", `> <!--\n\n${sentence()}\n`],
    [
      "after a comment that a block quote leaves open, past a link whose destination reads as a comment",
      `> <!--\n\n[a](<!-- x -->) ${sentence()}\n`,
    ],
    [
      "after an HTML block that opens with an empty comment, which renderers end at different lines",
      `<!--->\n\`<!--\`\n\n${sentence()}\n`,
    ],
    ["in a comment past an inline code span that crosses lines", `Note \` a\nb \` <!-- ${sentence()} --> \`\n`],
  ])("is not carried when it is %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });

  test("a fence of more characters closes only with at least as many", () => {
    const body = `\`\`\`\`\n\`\`\`\n${sentence()}\n\`\`\`\n\`\`\`\`\n`;
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });
});

describe("the digest helper", () => {
  test("sha256Digest is sha256: and 64 lower-case hex digits", () => {
    expect(lib.sha256Digest(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

// ── the examples in the documents ───────────────────────────────────────────────

/** The parsed JSON of each fenced json block in a document. */
function jsonBlocks(path: string): lib.JsonObject[] {
  const text = readFileSync(join(ROOT, path), "utf8");
  const blocks = [...text.matchAll(/^```json\n([\s\S]*?)^```/gm)].map((match) => lib.parseJson(match[1] ?? ""));
  return blocks.filter(isObj);
}
const isDeclaration = (value: lib.JsonObject) => "obligations" in value;
const isAttestation = (value: lib.JsonObject) => "head" in value;

const contractBlocks = () => jsonBlocks("adapters/supervisor/CONTRACT.md");
const firstmateBlocks = () => jsonBlocks("adapters/firstmate/SUPERVISOR.md");

describe("the examples in the documents", () => {
  test("the contract carries one declaration example and one attestation example", () => {
    expect(contractBlocks().filter(isDeclaration)).toHaveLength(1);
    expect(contractBlocks().filter(isAttestation)).toHaveLength(1);
  });

  test("the Firstmate adapter carries the exact declaration it writes", () => {
    expect(firstmateBlocks().filter(isDeclaration)).toHaveLength(1);
    expect(firstmateBlocks().find(isDeclaration)?.supervisor).toBe("firstmate");
  });

  test("each example passes the gate's validator and its schema unchanged", () => {
    const contractDeclaration = contractBlocks().find(isDeclaration);
    const contractAttestation = contractBlocks().find(isAttestation);
    const firstmateDeclaration = firstmateBlocks().find(isDeclaration);
    for (const example of [contractDeclaration, firstmateDeclaration]) {
      expect(example).toBeDefined();
      const name = nameOf(example);
      expect(lib.declarationFailures(example, name)).toEqual([]);
      expect(schemaOf("supervisor-declaration")(example)).toBe(true);
    }
    expect(contractAttestation).toBeDefined();
    const supervisor = nameOf(contractAttestation);
    expect(lib.attestationFailures(contractAttestation, supervisor)).toEqual([]);
    expect(schemaOf("supervisor-attestation")(contractAttestation)).toBe(true);
    const reviewBlock = contractAttestation?.review;
    const reviewer = isObj(reviewBlock) ? reviewBlock : {};
    expect(reviewer.authors).not.toContain(reviewer.reviewer);
  });

  test("the gate's start check accepts each declaration example from a file outside the checkout", () => {
    const examples = [contractBlocks().find(isDeclaration), firstmateBlocks().find(isDeclaration)];
    for (const example of examples) {
      const supervisor = nameOf(example);
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "ak-declaration-")));
      const file = join(outside, "declaration.json");
      writeFileSync(file, `${JSON.stringify(example, null, 2)}\n`);
      const project = realpathSync(makeTree({ "a.txt": "a\n" }));
      for (const args of [
        ["init", "-q", "-b", "main"],
        ["add", "-A"],
        ["commit", "-q", "-m", "init"],
      ]) {
        const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
          cwd: project,
        });
        expect(p.exitCode).toBe(0);
      }
      const keep = { ...process.env };
      process.env.AK_LIFECYCLE_POLICY = "unattended";
      process.env.AK_LIFECYCLE_SUPERVISOR = supervisor;
      process.env.AK_LIFECYCLE_SUPERVISOR_DECLARATION = file;
      try {
        const out: string[] = [];
        const err: string[] = [];
        const code = runCli(["lifecycle", "unattended", "check", "--phase", "super-ship"], {
          cwd: project,
          io: { out: (l) => out.push(l), err: (l) => err.push(l) },
        });
        expect(err.join("\n")).toBe("");
        expect(code).toBe(0);
        expect(JSON.parse(out.join("\n"))).toMatchObject({ supervisor, phase: "super-ship" });
      } finally {
        for (const key of ["AK_LIFECYCLE_POLICY", "AK_LIFECYCLE_SUPERVISOR", "AK_LIFECYCLE_SUPERVISOR_DECLARATION"]) {
          const before = keep[key];
          if (before === undefined) Reflect.deleteProperty(process.env, key);
          else process.env[key] = before;
        }
      }
    }
  });
});
