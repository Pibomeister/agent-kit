import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

import { splitSections } from "../src/validation/bodies.ts";
import { RULINGS_FILE, loadRulings } from "../src/validation/rulings.ts";

const REPO = join(import.meta.dir, "..");

const WALL =
  "No seat whose output is a finding, a receipt, a verdict or a signoff input is shown the trail, the trail audit or the attention list.";
const RULING = "work-trail-is-account-not-evidence";
const PROTOCOL = "protocols/work-trail/PROTOCOL.md";
const BUILD = "skills/super-build/SKILL.md";
const AUDITOR = "roles/trail-auditor/ROLE.md";
const VERIFIER = "roles/verifier/ROLE.md";
const CORRECTNESS = "roles/code-review/correctness/ROLE.md";
const GIVEN = "## What it must be given";
/** The words of the auditor's given item that hand it the stretches and name the trail. */
const STRETCHES = "every stretch of the ticket's trail";

/**
 * What the auditor's given section must name: trail in any case, with no letter, digit, underscore or
 * hyphen directly before or after it, so a hyphenated name such as `work-trail` or `trail-audit` does not count.
 */
const TRAIL_ALONE = /(?<![\p{L}\p{Nd}_-])trail(?![\p{L}\p{Nd}_-])/iu;
/** Trail as a word, in any case: `trailing` does not match, and a hyphenated name such as `work-trail` does. */
const TRAIL = /\btrail\b/i;
/** What only the auditor's given section may name. */
const WALLED = [
  { name: "the trail", pattern: TRAIL },
  { name: "the trail audit", pattern: /\btrail audit\b/i },
  { name: "the attention list", pattern: /\battention list\b/i },
];

/** The ruling's binds, exactly, and the files they resolve to. */
const BINDS = { protocols: ["work-trail"], roles: ["trail-auditor"], skills: ["super-build"] };
const BOUND = [PROTOCOL, AUDITOR, BUILD];

const collapse = (text: string): string => text.replace(/\s+/g, " ");
/** Whether a text carries the wall sentence word for word, wherever its lines wrap. */
const carries = (text: string): boolean => collapse(text).includes(WALL);

/** A body's given section with its whitespace collapsed, or empty when the body has none. */
function given(body: string): string {
  return collapse(splitSections(body).find((section) => section.heading === GIVEN)?.text ?? "");
}

/** Binds on one line, kinds and ids sorted, so two equal maps print the same. */
function listed(binds: Record<string, readonly string[]>): string {
  return Object.keys(binds)
    .toSorted()
    .map((kind) => `${kind}: ${(binds[kind] ?? []).toSorted().join(", ")}`)
    .join("; ");
}

/**
 * Every break in the wall, each as `<file>: <condition>`. An empty list means the wall holds: the
 * sentence is in the protocol, the build and the ruling; the auditor alone is given the trail; and
 * the ruling binds the protocol, the role and the skill, whose files exist.
 */
function wallFindings(input: {
  protocol: string;
  buildBody: string;
  ruling: { text: string; binds: Record<string, readonly string[]> };
  roles: Map<string, string>;
  exists: (path: string) => boolean;
}): string[] {
  const findings: string[] = [];
  if (!carries(input.protocol)) findings.push(`${PROTOCOL}: does not carry the wall sentence word for word`);
  if (!carries(input.buildBody)) findings.push(`${BUILD}: does not carry the wall sentence word for word`);
  if (!carries(input.ruling.text)) {
    findings.push(`${RULINGS_FILE}: the ruling ${RULING} does not carry the wall sentence word for word`);
  }
  if (!TRAIL_ALONE.test(given(input.roles.get(AUDITOR) ?? ""))) {
    findings.push(`${AUDITOR}: its given section does not name the trail`);
  }
  for (const [path, body] of input.roles) {
    if (path === AUDITOR) continue;
    const section = given(body);
    const named = WALLED.flatMap((term) => (term.pattern.test(section) ? [term.name] : []));
    if (named.length > 0) findings.push(`${path}: its given section names ${named.join(", ")}`);
  }
  if (listed(input.ruling.binds) !== listed(BINDS)) {
    findings.push(`${RULINGS_FILE}: ${RULING} binds ${listed(input.ruling.binds)}, not ${listed(BINDS)}`);
  }
  for (const path of BOUND) {
    if (!input.exists(path)) findings.push(`${path}: a bind of ${RULING} resolves to no file`);
  }
  return findings;
}

/** A repository file's text, or empty when the file is absent. */
function read(path: string): string {
  const full = join(REPO, path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

/** The texts the wall lives in, as this checkout has them. */
function realTexts() {
  const ruling = loadRulings(REPO).rows.find((row) => row.id === RULING);
  const roles = new Map<string, string>();
  for (const path of [...new Glob("roles/**/ROLE.md").scanSync(REPO)].toSorted()) roles.set(path, read(path));
  return {
    protocol: read(PROTOCOL),
    buildBody: read(BUILD),
    ruling: { text: ruling?.text ?? "", binds: ruling?.binds ?? {} },
    roles,
    exists: (path: string) => existsSync(join(REPO, path)),
  };
}

/** Where `body`'s given section starts and ends: at its heading and at the next heading. */
function givenSpan(body: string) {
  const start = body.indexOf(GIVEN);
  const end = start === -1 ? -1 : body.indexOf("\n## ", start);
  if (end === -1) throw new Error(`no section follows ${GIVEN}`);
  return { start, end };
}

/** `body` with a line of `words` added at the end of its given section. */
function givenPlus(body: string, words: string): string {
  const { end } = givenSpan(body);
  return `${body.slice(0, end)}\n${words}\n${body.slice(end)}`;
}

/** `body` with `from` reading `to` in its given section, and nowhere else. */
function givenReading(body: string, from: string, to: string): string {
  const { start, end } = givenSpan(body);
  const section = body.slice(start, end);
  if (!section.includes(from)) throw new Error(`the given section does not hold "${from}"`);
  return `${body.slice(0, start)}${section.replaceAll(from, to)}${body.slice(end)}`;
}

/** The real texts with one role body changed in memory. */
function withRole(path: string, change: (body: string) => string) {
  const real = realTexts();
  const body = real.roles.get(path);
  if (body === undefined) throw new Error(`${path} is not among the roles read`);
  return { ...real, roles: new Map(real.roles).set(path, change(body)) };
}

/**
 * The wall (ruling `work-trail-is-account-not-evidence`) is held by what seats are handed, and no
 * validator rule checks it. These tests read the texts that carry it, and each broken copy changes
 * one file in memory and must be refused by name.
 */
describe("the wall around the trail", () => {
  test("holds on the real tree", () => {
    const real = realTexts();
    // Guard against an empty subject: with no role read, the given-section checks check nothing.
    expect(real.roles.size).toBeGreaterThan(1);
    expect(wallFindings(real)).toEqual([]);
  });

  test("refuses a second role given the trail, naming it", () => {
    const broken = withRole(VERIFIER, (body) => givenPlus(body, "the trail"));
    expect(wallFindings(broken)).toEqual([`${VERIFIER}: its given section names the trail`]);
  });

  test("refuses a judging role given the attention list, naming it", () => {
    const broken = withRole(CORRECTNESS, (body) => givenPlus(body, "the attention list"));
    expect(wallFindings(broken)).toEqual([`${CORRECTNESS}: its given section names the attention list`]);
  });

  test("refuses a super-build body without the wall sentence, naming it", () => {
    const real = realTexts();
    const flat = collapse(real.buildBody);
    // Guard against an empty subject: a body without the sentence would be refused with nothing removed.
    expect(flat).toContain(WALL);
    const broken = { ...real, buildBody: flat.replaceAll(WALL, "") };
    expect(wallFindings(broken)).toEqual([`${BUILD}: does not carry the wall sentence word for word`]);
  });

  test("refuses a trail auditor that names the trail only inside work-trail, naming it", () => {
    const section = given(realTexts().roles.get(AUDITOR) ?? "");
    // Guard against an empty subject: the copy must lose the trail from the stretches item and keep
    // work-trail, so that only the strict match can refuse it.
    expect(section).toContain(STRETCHES);
    expect(section).toContain("work-trail");
    const broken = withRole(AUDITOR, (body) => givenReading(body, STRETCHES, "every stretch of the ticket"));
    expect(wallFindings(broken)).toEqual([`${AUDITOR}: its given section does not name the trail`]);
  });
});
