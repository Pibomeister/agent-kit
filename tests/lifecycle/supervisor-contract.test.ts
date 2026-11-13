/**
 * The supervisor contract's two file shapes (docs/decisions/0014-unattended-lifecycle-policy.md, amendment of
 * 2026-11-11; adapters/supervisor/CONTRACT.md): the JSON schemas and the gate's validators accept and reject the
 * same shape fixtures, the canonical identity pattern is pinned, and the examples in the two documents pass the
 * gate's own validators and the gate's start check unchanged. The disclosure tables call `bodyCarriesDisclosure`
 * directly: bodies that show the sentence, and bodies that hide it in a comment, a code block or an HTML block of any
 * of the seven CommonMark types, including where a backslash escape, raw HTML, an autolink or a link takes a backtick
 * before a code span can open, where lines end in CRLF or a byte order mark leads, and where the two CommonMark
 * readings in use part on an HTML block. The digest helper is pinned too.
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
    ["after a code span that crosses a line", `Summary \`a\nb\` done.\n\n${sentence()}\n`],
    [
      "after a code span that holds a comment opener in the same paragraph",
      `Use \`<!--\` to open one. ${sentence()}\n`,
    ],
    ["after a link and a code span that holds a comment opener", `See [x](/u "t") and \`<!--\`. ${sentence()}\n`],
    ["after an escaped backtick", `Summary \\\` done. ${sentence()}\n`],
    ["after a tag and an inline empty comment", `Summary <b>x</b> <!--> ${sentence()}\n`],
    ["as the text of a link", `[${sentence()}](/u)\n`],
    ["after a comment on the line that opens its HTML block", `<!-- note --> ${sentence()}\n`],
    ["on a paragraph line four columns in that starts with a block tag", `Summary\n    <div> ${sentence()}\n`],
  ])("is carried %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(true);
  });

  const tick = "`";
  // Each construct is read whole, so the code span after it opens and the comment opener in that span starts nothing.
  test.each([
    ["a processing instruction", "<?x?>"],
    ["a CDATA section", "<![CDATA[x]]>"],
    ["a declaration", "<!DOCTYPE x>"],
    ["a closed comment", "<!-- x -->"],
    ["an inline empty comment", "<!-->"],
    ["an inline empty dash comment", "<!--->"],
    ["a URI autolink", "<https://x.invalid/>"],
    ["an email autolink", "<a@x.invalid>"],
    ["an open tag", '<b title="x">'],
    ["an inline link", '[x](/u "t")'],
    ["an image", "![x](/u)"],
    ["an escaped comment opener", "\\<!--"],
  ])("is carried after %s and a code span that holds a comment opener", (_name, before) => {
    const body = `Summary ${before} ${tick}<!--${tick} ${sentence()}\n`;
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(true);
  });

  // CommonMark reads a backslash escape, raw HTML, an autolink and a link's destination, title or label before a code
  // span, so a backtick they take opens none and the comment hides the sentence (rows read X<!--, sentence, ` -->).
  test.each([
    ["a backslash escape", `\\${tick}`],
    ["a tag attribute", `<span title="${tick}"></span>`],
    ["a URI autolink", `<https://example.invalid/${tick}>`],
    ["a double-quoted link title", `[x](https://example.invalid "${tick}")`],
    ["an angle-bracket link destination with an escaped line ending", `[x](<a\\\nb${tick}>)`],
    ["a processing instruction", `<?x ${tick}?>`],
    ["a CDATA section", `<![CDATA[${tick}]]>`],
    ["an upper-case declaration", `<!DOCTYPE ${tick}>`],
    ["a lower-case declaration, which only the 0.31 reading takes", `<!doctype ${tick}>`],
    ["an email autolink", `<a${tick}b@example.invalid>`],
    ["an angle-bracket link destination", `[x](<${tick}>)`],
    ["a bare link destination", `[x](/u${tick})`],
    ["a single-quoted link title", `[x](/u '${tick}')`],
    ["a parenthesised link title", `[x](/u (${tick}))`],
    ["a link title past an escaped quote", `[x](/u "a\\"${tick}")`],
    ["a bare link destination past an escaped parenthesis", `[x](/u\\)${tick})`],
    ["an angle-bracket link destination past an escaped >", `[x](<a\\>${tick}>)`],
    ["an autolink that holds a delete character", `<https://x.invalid/\u007f${tick}>`],
    ["an extended autolink after ://", `https://example.invalid/${tick}`],
    ["an extended autolink after www.", `www.example.invalid/${tick}`],
    ["math between dollar signs", `$a${tick}b$`],
  ])("is not carried in a comment after a backtick in %s", (_name, before) => {
    const body = `Summary ${before}<!--\n${sentence()}\n${tick} -->\n`;
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });

  // A construct that does not form leaves its backtick to open a code span with the next one, and the comment after
  // that span hides the sentence (rows read X, ` <!--, sentence, ` -->).
  test.each([
    ["a destination past the parenthesis limit", `[x](${"(".repeat(33)}a${tick}${")".repeat(33)})`],
    ["an angle-bracket destination that holds <", `[x](<a<${tick}>)`],
    ["an angle-bracket destination that crosses a line", `[x](<a\nb${tick}>)`],
    ["a parenthesised title that holds (", `[x](/u (a(${tick}))`],
    ["a tag whose unquoted attribute value holds the backtick", `<a b=c${tick}d>`],
    ["a link whose text holds a link", `[a [b](y) c](x${tick})`],
  ])("is not carried in a comment when %s forms no construct", (_name, before) => {
    const body = `Summary ${before} ${tick} <!--\n${sentence()}\n${tick} -->\n`;
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });

  test.each([
    ["a defined reference label", `Summary [x][y${tick}]<!--\n${sentence()}\n${tick} -->\n\n[y${tick}]: /u\n`],
    ["a footnote label", `Summary [^a${tick}]<!--\n${sentence()}\n${tick} -->\n\n[^a${tick}]: note\n`],
    ["a link definition title", `[a]: /u "${tick}"\nx <!--\n${sentence()}\n${tick} -->\n`],
    [
      "a link that a defined reference inside its text stops forming",
      `Summary [a [b] c](x${tick}) ${tick} <!--\n${sentence()}\n${tick} -->\n\n[b]: /u\n`,
    ],
  ])("is not carried in a comment after %s that takes a backtick", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });

  // Where cmark-gfm (CommonMark 0.29) and pandoc (0.31) part, one shows the sentence and the other hides it. With
  // `pandocShows` the construct takes the backtick only in pandoc, which then shows the sentence in a code span; with
  // `cmarkShows` only cmark-gfm leaves the backtick to pair with the one after the sentence.
  const pandocShows = (before: string) => `Summary ${before} ${tick} <!--\n${sentence()}\n${tick} -->\n`;
  const cmarkShows = (before: string) => `Summary ${before}<!--\n${sentence()}\n${tick} -->\n`;
  const split = (opener: string) => `Summary ${sentence().replace(" ", ` ${opener}`)}\n`;
  test.each([
    ["a comment that holds --, where pandoc shows it", pandocShows(`<!-- a -- ${tick} -->`)],
    ["a comment that holds --, where cmark-gfm shows it", cmarkShows(`<!-- a -- ${tick} -->`)],
    ["a comment that ends in -, where pandoc shows it", pandocShows(`<!-- a ${tick} --->`)],
    ["a comment that ends in -, where cmark-gfm shows it", cmarkShows(`<!-- a ${tick} --->`)],
    ["a processing instruction that ends in ?, where pandoc shows it", pandocShows(`<?a${tick}??>`)],
    ["a processing instruction that ends in ?, where cmark-gfm shows it", cmarkShows(`<?a${tick}??>`)],
    ["a CDATA section that holds ], where pandoc shows it", pandocShows(`<![CDATA[a${tick}]]]>`)],
    ["a CDATA section that holds ], where cmark-gfm shows it", cmarkShows(`<![CDATA[a${tick}]]]>`)],
    ["a lower-case declaration, where pandoc shows it", pandocShows(`<!doctype a${tick}>`)],
    [
      "a tag whose unquoted value holds a control character, where pandoc shows it",
      pandocShows(`<a b=c\u0001 d="${tick}">`),
    ],
    ["a title right after an angle-bracket destination, where pandoc shows it", pandocShows(`[x](<u>"${tick}")`)],
    ["a title right after an angle-bracket destination, where cmark-gfm shows it", cmarkShows(`[x](<u>"${tick}")`)],
    [
      "a parenthesised title right after an empty angle-bracket destination, where cmark-gfm shows it",
      cmarkShows(`[x](<>(${tick}))`),
    ],
    ["an inline empty comment inside it", split("<!-->")],
    ["an inline empty dash comment inside it", split("<!--->")],
    ["a comment that holds -- inside it", split("<!-- a -- x -->")],
    [
      "a comment that holds -- inside it, after a control character",
      split("<!-- a -- x -->").replace("Summary", "\u0001"),
    ],
    ["an inline empty comment inside it, after a dollar sign", split("<!-->").replace("Summary", "$")],
  ])("is not carried where the renderers part on %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
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
    ["only in a tag attribute", `Summary <span title="${sentence()}"></span>\n`],
    ["only in a comment inside a tag attribute", `Summary <span title="<!-- ${sentence()} -->"></span>\n`],
    ["only in a comment inside a link title", `Summary [x](/u "<!-- ${sentence()} -->")\n`],
    ["only in a comment inside a declaration", `Summary <!X <!-- ${sentence()} -->\n`],
    ["only inside a fence whose lines end in CRLF", `\`\`\`\r\n${sentence()}\r\n\`\`\`\r\n`],
    ["only inside a fence after a byte order mark", `\ufeff\`\`\`\n${sentence()}\n\`\`\`\n`],
    ["only inside a fence whose info string holds a line separator", `~~~\u2028x\n${sentence()}\n~~~\n`],
    [
      "past a comment opener that its paragraph does not close, in a footnote definition that no reference uses",
      `Summary <!-- x\n[^a]: note\n${sentence()}\n`,
    ],
    [
      "past a comment opener that its paragraph does not close, in a tag attribute after an extended autolink",
      `Summary <!-- x www.a <span title="${sentence()}"></span>\n`,
    ],
  ])("is not carried when it is %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });

  // An HTML block of any of the seven CommonMark types passes its lines through raw: no code span forms there, so a
  // comment opener inside backticks opens a page comment, and a block that ends at its own line leaves the next
  // indented line to indented code. Each row's block hides the sentence in the render.
  const opener = `${tick}<!--${tick}`;
  test.each([
    [
      "a declaration block whose line in a block quote leaves a comment open",
      `<!DOCTYPE x>\n> <!DOCTYPE ${tick}>${opener}[x](/u${tick})\n- ${sentence()}\n`,
    ],
    [
      "a declaration block that ends at its own line, before an indented line",
      `<!DOCTYPE ${tick}> x <b>\n    ${sentence()}\n`,
    ],
    ["a pre block whose content opens a comment", `<pre>\n${opener}\n</pre>\n\n${sentence()}\n`],
    ["a pre block that ends at its own line, before an indented line", `<pre>x</pre>\n    ${sentence()}\n`],
    ["a style block that opens a comment after its end tag", `<style>x</style> ${opener}\n\n${sentence()}\n`],
    ["an upper-case pre block that another end tag ends", `<PRE>\nx\n</style> ${opener}\n\n${sentence()}\n`],
    ["a processing instruction block that opens a comment after its end", `<?x ?> ${opener}\n\n${sentence()}\n`],
    ["a CDATA block that opens a comment after its end", `<![CDATA[x]]> ${opener}\n\n${sentence()}\n`],
    ["a comment block that ends at its end marker, before an indented line", `<!--\nx\n-->\n    ${sentence()}\n`],
    ["a div block whose next line opens a comment", `<div>\n${opener}\n\n${sentence()}\n`],
    ["an upper-case div block that interrupts a paragraph", `Summary\n<DIV>${opener}\n\n${sentence()}\n`],
    ["a block that a closing div tag opens", `</div> ${opener}\n\n${sentence()}\n`],
    ["a block that a self-closing div tag opens", `<div/>${opener}\n\n${sentence()}\n`],
    ["a span tag alone on its line", `<span>\n${opener}\n\n${sentence()}\n`],
    ["a closing span tag alone on its line", `</span>\n${opener}\n\n${sentence()}\n`],
    ["a tag with attributes alone on its line", `<a href="x" title='y' z>\n${opener}\n\n${sentence()}\n`],
    ["a span tag alone on a lazy line after a block quote", `> Summary\n<span>\n${opener}\n\n${sentence()}\n`],
    ["a div block in a list item", `- <div>\n  ${opener}\n\n${sentence()}\n`],
  ])("is not carried after %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(false);
  });

  test("is not carried in an attribute of a tag that crosses the lines of an HTML block", () => {
    expect(lib.bodyCarriesDisclosure(`<div title="\n${sentence()}\n">\n`, "firstmate")).toBe(false);
  });

  // The check fails closed here: a browser shows the text of a div, but no text inside an HTML block that opens with
  // anything other than a comment counts, because a tag or an attribute value there may cross the block's lines.
  test("is not carried inside an HTML block that opens with no comment, though a browser shows it", () => {
    expect(lib.bodyCarriesDisclosure(`<div>\n${sentence()}\n</div>\n`, "firstmate")).toBe(false);
  });

  // Each row's block ends where CommonMark ends it, so the backticks on the next line form a code span again.
  test.each([
    ["a div block that a blank line ends", `<div>\n\n${opener}\n\n${sentence()}\n`],
    ["a div block that a CRLF blank line ends", `<div>\r\n\r\n${opener}\r\n\r\n${sentence()}\r\n`],
    ["a div block that its block quote ends", `> <div>\n${opener}\n\n${sentence()}\n`],
    ["a pre block that ends at its end tag", `<pre>\nx\n</pre>\n${opener}\n\n${sentence()}\n`],
    ["a processing instruction block that ends at its end marker", `<?x\n?>\n${opener}\n\n${sentence()}\n`],
    ["a declaration block that ends at its own line", `<!DOCTYPE x>\n${opener}\n\n${sentence()}\n`],
    ["a CDATA block that ends at its end marker", `<![CDATA[\nx]]>\n${opener}\n\n${sentence()}\n`],
    ["an HTML block line that closes a comment a block quote left open", `> <!--\n\n<div>-->\n\n${sentence()}\n`],
    ["a paragraph that a span tag alone on its line continues", `Summary\n<span>\n${opener}\n\n${sentence()}\n`],
    ["a paragraph that starts with a tag that text follows", `<span>x</span> ${opener}\n\n${sentence()}\n`],
    ["a paragraph that starts with a longer tag name than div", `<divx> ${opener}\n\n${sentence()}\n`],
    ["a paragraph that starts with a longer tag name than pre", `<prex> ${opener}\n\n${sentence()}\n`],
    ["a paragraph that starts with <! and no letter", `<!1 ${opener}\n\n${sentence()}\n`],
    ["a paragraph whose lines end in CRLF", `Summary.\r\n\r\n${sentence()}\r\n`],
    [
      "a div block with a tab after its name that a blank line ends",
      `<div\tclass="x">\n\n${opener}\n\n${sentence()}\n`,
    ],
    ["a comment block that holds a textarea end tag", `<!--\n</textarea>\n-->\n${sentence()}\n`],
  ])("is carried after %s", (_name, body) => {
    expect(lib.bodyCarriesDisclosure(body, "firstmate")).toBe(true);
  });

  // Where CommonMark 0.29 (cmark-gfm) and 0.31 (pandoc), or a renderer and the spec, part on an HTML block start or end
  // or on a line ending, one reading hides the sentence. The check stops reading at that line and drops the paragraph
  // it might continue.
  test.each([
    ["a lower-case declaration, a block only in 0.31", `<!doctype x>\n    ${sentence()}\n`],
    [
      "a textarea block, which only 0.31 runs past a blank line",
      `<textarea>\n\n</textarea> ${opener}\n\n${sentence()}\n`,
    ],
    ["a search block, which only 0.31 lets interrupt a paragraph", `Summary\n<search>\n${opener}\n\n${sentence()}\n`],
    ["a source block, which only 0.29 lets interrupt a paragraph", `Summary\n<source>\n${opener}\n\n${sentence()}\n`],
    ["a Kelvin sign that pandoc lower-cases to k in link", `Summary\n<lin\u212a>\n${opener}\n\n${sentence()}\n`],
    ["a Kelvin sign that pandoc lower-cases to k in a lone tag", `<\u212a>\n${opener}\n\n${sentence()}\n`],
    ["a Kelvin sign that pandoc lower-cases to k after <!", `<!\u212a x>\n    ${sentence()}\n`],
    ["a vertical tab after a block tag name, a space only in 0.29", `<div\u000b>\n${opener}\n\n${sentence()}\n`],
    [
      "a textarea end tag, which ends a pre block only in 0.31",
      `<pre>\n</textarea>\n\n${opener}\n</pre>\n\n${sentence()}\n`,
    ],
    [
      "a self-closing pre tag, which pandoc reads as a block and the spec does not",
      `<pre/>\n${opener}\n\n${sentence()}\n`,
    ],
    ["a lone carriage return, a line ending in cmark-gfm that pandoc drops", `<div>\r\r${opener}\n\n${sentence()}\n`],
    ["an empty processing instruction, which pandoc runs on past its line", `<?>\n${opener}\n\n${sentence()}\n`],
    ["a paragraph line that a lower-case declaration may continue", `Summary <a title="${sentence()}\n<!doctype x">\n`],
    [
      "a self-closing pre tag before a fence line, a block in pandoc and a paragraph in the spec",
      `<pre/>\n~~~\n\n${sentence()}\n`,
    ],
    [
      "a lone pre end tag before a fence line, a block in pandoc and a paragraph in the spec",
      `</pre>\n~~~\n\n${sentence()}\n`,
    ],
    [
      "a Kelvin sign in a lone tag before a fence line, a block in pandoc and a paragraph in the spec",
      `<\u212a>\n~~~\n\n${sentence()}\n`,
    ],
    [
      "a textarea end tag in a pre block before a fence line, which only 0.31 ends the block at",
      `<pre>\n</textarea>\n~~~\n</pre>\n${sentence()}\n`,
    ],
    [
      "a textarea end tag on the line that opens a pre block, which only 0.31 ends the block at",
      `<pre></textarea>\n\n${opener}\n</pre>\n\n${sentence()}\n`,
    ],
    [
      "a lone carriage return after the sentence's line, where pandoc reads a tag across it",
      `Summary <a title="${sentence()}\n\r">\n`,
    ],
  ])("is not carried where the renderers part on %s", (_name, body) => {
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
