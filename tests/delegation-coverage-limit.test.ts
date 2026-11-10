/**
 * Under the unattended policy, no agent-kit project record, or a valid one without delegation
 * guidance, is a recorded delegation coverage limit, never a lifecycle stop. A project record that
 * fails its schema still stops under every policy, and outside the unattended policy missing
 * delegation guidance is still needs-input.
 *
 * A live unattended run stopped in planning on super-bound's "Delegation guidance on that same
 * project record. Missing it is needs-input", which the unattended clause did not waive, while the
 * unattended-lifecycle reference listed "bound without project guidance" as a stop. This pins the
 * wording an agent reads in super-bound, its readers (build, ship) and the two references; checks
 * that no sentence in the lifecycle skills or those references ties a stop to the missing record or
 * guidance under the unattended policy; that the ticket schema keeps an unscored ticket valid; and
 * that the evals grade the same contract on scaffolds whose policy and record are what they claim.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import project from "./fixtures/delegation/valid.project.json" with { type: "json" };
import ticket from "./fixtures/delegation/valid.ticket.json" with { type: "json" };
import { resolvePolicy } from "../src/lifecycle/unattended.ts";
import { compileSchemas } from "../src/validation/schemas.ts";

const REPO = join(import.meta.dir, "..");

/** The file's text with backticks dropped and every run of whitespace, YAML indentation included, made one space. */
function flat(path: string): string {
  return readFileSync(join(REPO, path), "utf8").replaceAll("`", "").replaceAll(/\s+/g, " ");
}

const BOUND = ["skills/super-bound/SKILL.md", "skills/super-bound/skill.yaml"];
const UNSCORED = "delegation unscored: <cause> (coverage limit)";

describe("super-bound under the unattended policy", () => {
  test.each(BOUND)("%s waives a missing project record or delegation guidance as a coverage limit", (file) => {
    const text = flat(file);
    expect(text).toContain(
      "Under the unattended policy, no project record, or a valid one without delegation guidance, is a delegation coverage limit",
    );
    expect(text).toContain("record it once naming its cause");
    expect(text).toContain("run no ak delegation");
    expect(text).toContain(UNSCORED);
    expect(text).toContain("never stops this phase");
  });

  test.each(BOUND)("%s still stops on a project record that fails its schema, under every policy", (file) => {
    expect(flat(file)).toContain(
      "A present project record that fails schemas/project.schema.json validation is needs-input under every policy",
    );
  });

  test.each(BOUND)("%s keeps missing delegation guidance a needs-input stop outside the unattended policy", (file) => {
    expect(flat(file)).toContain("Outside the unattended policy, missing delegation guidance is needs-input");
  });

  test("SKILL.md never invents scorer inputs and skips the scorer steps under the limit", () => {
    const text = flat("skills/super-bound/SKILL.md");
    expect(text).not.toContain("Missing it is needs-input");
    expect(text).toContain("Scorer inputs are never invented");
    expect(text).toContain("Under a delegation coverage limit this step runs nothing");
    expect(text).toContain("except an unscored ticket under a delegation coverage limit");
  });

  test("skill.yaml no longer requires the project record at the schema level and grades the new contract", () => {
    const raw = readFileSync(join(REPO, "skills/super-bound/skill.yaml"), "utf8");
    const input = raw.match(/- id: project-guidance\n(?: {4}.*\n)+/)?.[0] ?? "";
    expect(input).toContain("required: false");
    const ids = [...raw.matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toContain("unattended-without-project-record-continues-unscored");
    expect(ids).toContain("invalid-project-record-stops");
  });
});

describe("the references agree", () => {
  test("the unattended-lifecycle reference no longer lists bound without project guidance as a stop", () => {
    const text = flat("references/unattended-lifecycle/REFERENCE.md");
    expect(text).not.toContain("bound without project guidance");
    expect(text).toContain("a knowledgebase coverage limit is not one");
    expect(text).toContain(
      "a delegation coverage limit is not one, and a knowledgebase coverage limit is not one either",
    );
    expect(text).toContain("no project record, or a valid one without delegation guidance");
    expect(text).toContain("never stops a phase");
    expect(text).toContain(UNSCORED);
    expect(text).toContain("a project record that fails schemas/project.schema.json validation");
  });

  test("the delegation reference treats an unscored ticket as a coverage limit, not a missing scorer run", () => {
    const text = flat("references/delegation/REFERENCE.md");
    expect(text).toContain("Under the unattended policy only, a delegation coverage limit");
    expect(text).toContain("no project record, or a valid one without delegation guidance");
    expect(text).toContain("is not a missing scorer run and never stops a phase");
    expect(text).toContain(UNSCORED);
    expect(text).toContain(
      "A project record that fails schemas/project.schema.json validation stops under every policy",
    );
  });
});

describe("downstream readers accept an unscored ticket under the unattended policy", () => {
  test("super-build records no class for an unscored ticket", () => {
    const text = flat("skills/super-build/SKILL.md");
    expect(text).toContain(
      "An unscored ticket (the delegation reference's coverage limit) is built the same way with no class recorded",
    );
    expect(text).toContain("An unscored ticket has no class to pass");
  });

  test("super-ship states the class as unscored instead of deriving one", () => {
    expect(flat("skills/super-ship/SKILL.md")).toContain(
      "An unscored ticket's class is stated as unscored with its coverage limit, never derived",
    );
  });

  test("the ticket schema keeps an unscored ticket valid without a delegation block", () => {
    const schemas = compileSchemas(REPO);
    const validateTicket = schemas.validatorFor("ticket");
    const validateProject = schemas.validatorFor("project");
    if (validateTicket === undefined || validateProject === undefined) throw new Error("schemas did not compile");
    const { delegation: _scored, ...rest } = ticket;
    const unscored = {
      ...rest,
      assumptions: [
        ...ticket.assumptions,
        { text: "delegation unscored: no project record (coverage limit)", resolved_as: "non-goal" },
      ],
    };
    expect(validateTicket(unscored)).toBe(true);
    // A present record without delegation guidance is a valid record, the limit's second cause.
    const { delegation: _guidance, ...guidance } = project.guidance;
    expect(validateProject({ ...project, guidance })).toBe(true);
  });
});

/** A sentence naming the cause: no project record, missing delegation or project guidance, or an unscored ticket. */
const CAUSE =
  /no project record|absent project record|project record is (?:absent|missing)|(?:missing|without) (?:project|delegation) guidance|delegation guidance (?:is )?missing|project (?:delegation )?guidance(?: or a grant)? is missing|delegation coverage limit|delegation unscored|unscored ticket/i;
/** The phrasings that say the limit does not stop, and "block" as a noun, removed before a stop is looked for. */
const NOT_A_STOP =
  /never stops?|does not stop|do not stop|not stop(?:ping)?(?: for it)?|without stopping|stops nothing|(?:never|rather than) a stop|is not one(?: either)?|## stop conditions|delegation block|every block|blocking edges?/gi;
/** A stop in any of its wordings: needs-input, a stop, a failure, a refusal or a block. */
const STOP =
  /needs-input|needs input|\bstop(?:s|ped|ping)?\b|\bfail(?:s|ed|ing)?\b|\brefus(?:e|es|ed|ing)\b|\bblock(?:s|ed|ing)?\b/i;
/** A clause scoped outside the unattended policy, or about an invalid record: both may stop. */
const MAY_STOP =
  /outside the unattended policy|\battended\b|fails schemas\/project\.schema\.json|fails (?:its )?(?:schema )?validation/i;
/** Clause boundaries inside a sentence: commas, colons, dashes and contrasting conjunctions. */
const CLAUSE = /,\s+|:\s+|\s[—–]\s|\s(?:but|while|whereas|although|though|unless|except)\s/i;

/**
 * Sentences (and table cells) of a flattened file that tie a stop to the missing record or guidance
 * under the unattended policy. Read clause by clause: a clause stops when, with its own negations
 * dropped, it still names a stop, and it is tied to the cause when it or the clause before it names
 * one, or the clause after it does ("every other stop still stops: <cause>"). A clause scoped outside
 * the unattended policy, or about a record that fails its schema, may stop, as may one directly
 * after such a scope.
 */
function stopsOnDelegationLimit(text: string): string[] {
  return text
    .split(/(?<=[.;])\s+|\s-\s|\s?\|\s/)
    .filter((s) => CAUSE.test(s))
    .filter((s) => {
      const clauses = s.split(CLAUSE);
      return clauses.some((clause, i) => {
        const previous = clauses[i - 1] ?? "";
        if (MAY_STOP.test(clause) || MAY_STOP.test(previous)) return false;
        if (!STOP.test(clause.replaceAll(NOT_A_STOP, ""))) return false;
        return CAUSE.test(clause) || CAUSE.test(previous) || CAUSE.test(clauses[i + 1] ?? "");
      });
    });
}

describe("no lifecycle instruction ties a stop to the delegation coverage limit", () => {
  const files = [
    ...["align", "bound", "scout", "build", "verify", "review", "ship"].flatMap((p) => [
      `skills/super-${p}/SKILL.md`,
      `skills/super-${p}/skill.yaml`,
    ]),
    "references/unattended-lifecycle/REFERENCE.md",
    "references/delegation/REFERENCE.md",
  ];

  test("the conflict check catches the stop wording it guards against", () => {
    expect(stopsOnDelegationLimit("Missing project guidance or grant at bound.run is needs-input.")).toHaveLength(1);
    expect(
      stopsOnDelegationLimit(
        "Every other stop still stops: a missing prerequisite (for example bound without project guidance), a blocking finding.",
      ),
    ).toHaveLength(1);
    expect(stopsOnDelegationLimit("With no project record, the run is failed.")).toHaveLength(1);
    expect(stopsOnDelegationLimit("An unscored ticket blocks the build.")).toHaveLength(1);
    expect(
      stopsOnDelegationLimit("A delegation coverage limit never stops review, but no project record stops ship."),
    ).toHaveLength(1);
    expect(stopsOnDelegationLimit("A delegation coverage limit never stops this phase.")).toEqual([]);
    expect(
      stopsOnDelegationLimit("An unscored ticket carries no delegation block and every block but delegation."),
    ).toEqual([]);
    expect(
      stopsOnDelegationLimit("Outside the unattended policy, missing delegation guidance is needs-input."),
    ).toEqual([]);
    expect(
      stopsOnDelegationLimit(
        "No project record is a delegation coverage limit, while a project record that fails schemas/project.schema.json validation stops.",
      ),
    ).toEqual([]);
  });

  test.each(files)("%s", (file) => {
    expect(stopsOnDelegationLimit(flat(file))).toEqual([]);
  });
});

/** A super-bound case's flattened text and its grader names. */
function load(id: string) {
  const raw = readFileSync(join(REPO, `evals/super-bound/${id}/case.yaml`), "utf8");
  return {
    text: flat(`evals/super-bound/${id}/case.yaml`),
    graders: [...raw.matchAll(/^ {2}- name: (\S+)$/gm)].map((m) => m[1]),
  };
}

/** The scaffolded workspace's resolved policy and project record, with no policy in the environment. */
function premise(id: string) {
  const tmp = mkdtempSync(join(tmpdir(), "delegation-case-"));
  try {
    const scaffold = spawnSync("bash", [join(REPO, `evals/super-bound/${id}/scaffold.sh`)], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(scaffold.status, scaffold.stderr).toBe(0);
    const resolved = resolvePolicy(tmp, {});
    const policy = resolved.ok ? resolved.policy?.name : undefined;
    const path = join(tmp, "project.json");
    if (!existsSync(path)) return { policy, record: "absent" as const };
    const validateProject = compileSchemas(REPO).validatorFor("project");
    const valid = validateProject?.(JSON.parse(readFileSync(path, "utf8"))) === true;
    return { policy, record: valid ? ("valid" as const) : ("invalid" as const) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("super-bound delegation evals", () => {
  test("an unattended run with no project record continues and leaves every ticket unscored", () => {
    const c = load("unattended-without-project-record-continues-unscored");
    expect(c.text).toContain("does not stop");
    expect(c.text).not.toMatch(/stops with needs-input/);
    expect(c.text).toContain("delegation unscored");
    expect(c.graders).toContain("no-scorer-run");
    expect(c.graders).toContain("no-project-record-invented");
    expect(premise("unattended-without-project-record-continues-unscored")).toEqual({
      policy: "unattended",
      record: "absent",
    });
  });

  test("an unattended run with an invalid project record stops", () => {
    const c = load("invalid-project-record-stops");
    expect(c.text).toContain("The response stops with needs-input");
    expect(c.text).toContain("not a coverage limit");
    expect(c.graders).toContain("no-ticket-written");
    expect(premise("invalid-project-record-stops")).toEqual({ policy: "unattended", record: "invalid" });
  });
});
