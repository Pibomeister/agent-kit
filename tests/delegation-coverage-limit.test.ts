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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** The whole unscored assumption: the cause, the floor not evaluated, and the packs and sensitive actions in its place. */
const UNSCORED_FULL =
  "delegation unscored: <cause> (coverage limit); floor not evaluated; packs: <ids or none>; sensitive actions: <ids or none>";
/** The two ak delegation errors that decide a present record (src/delegation.ts). */
const SCHEMA_ERROR = "ak delegation: project does not match its schema";
const GUIDANCE_ERROR = "ak delegation: project has no guidance.delegation block (weights and cut points)";

/** What a missing ak delegation command is: the T6 shape for a missing ak kb command. */
const MISSING_COMMAND =
  "A missing ak delegation command is one not on PATH, an unknown subcommand or a usage error from an older CLI, as in a sandbox with only node <bundle>/bin/ak-gate.mjs";
/** With the command missing, a present record's validity is recorded as not checked, never a stop. */
const NOT_CHECKED = "missing ak delegation command, project record validity not checked";

/** The persisted unscored ticket keeps no delegation block, so build never finds a class to pass. */
const NO_SEED =
  "the persisted unscored ticket carries no delegation block, seeded or default, so build has no class to pass";
/** The ticket-side errors, which are about the draft and never decide the record. */
const TICKET_SIDE =
  "A ticket-side error (ak delegation: ticket has no delegation block to score, or ak delegation: ticket does not match its schema: …) is about the draft, not the record";

/** The draft an unscored ticket is when the decision runs: the valid fixture with no delegation block. */
const { delegation: _scored, ...unscoredTicket } = ticket;

/** The real `ak delegation` (src/cli.ts) on a ticket and a project record, in `cwd`: its exit and stderr. */
function realAk(cwd: string, ticketPath: string, projectPath: string) {
  const r = spawnSync(
    process.execPath,
    [join(REPO, "src/cli.ts"), "delegation", ticketPath, "--project", projectPath],
    {
      cwd,
      encoding: "utf8",
    },
  );
  return { code: r.status, err: (r.stderr ?? "").trim() };
}

describe("super-bound under the unattended policy", () => {
  test.each(BOUND)("%s waives a missing project record or delegation guidance as a coverage limit", (file) => {
    const text = flat(file);
    expect(text).toContain(
      "Under the unattended policy, no project record, a valid one without delegation guidance, or a missing ak delegation command, is a delegation coverage limit",
    );
    expect(text).toContain(MISSING_COMMAND);
    expect(text).toContain(NOT_CHECKED);
    expect(text).toContain("record it once naming its cause");
    expect(text).toContain(UNSCORED_FULL);
    expect(text).toContain("never stops this phase");
    expect(text).toContain("every required sensitive action still stops");
  });

  test.each(BOUND)("%s decides a present record with ak delegation, and only an absent record skips it", (file) => {
    const text = flat(file);
    expect(text).not.toContain("run no ak delegation");
    expect(text).toContain(
      "A present project record is decided by ak delegation, never by hand, whether or not the draft ticket carries a delegation block",
    );
    expect(text).toContain(`${SCHEMA_ERROR}: … is needs-input under every policy`);
    expect(text).toContain(`${GUIDANCE_ERROR} is the coverage limit`);
    expect(text).toContain("Only an absent project record skips ak delegation");
    expect(text).toContain("Decide it at step 10");
    expect(text).toContain(NO_SEED);
    expect(text).toContain(TICKET_SIDE);
  });

  test("the real ak delegation decides a present record before it reads the ticket's missing block", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-errors-"));
    try {
      writeFileSync(join(dir, "unscored.json"), JSON.stringify(unscoredTicket));
      writeFileSync(join(dir, "seeded.json"), JSON.stringify(ticket));
      const { delegation: _guidance, ...guidance } = project.guidance;
      writeFileSync(join(dir, "no-guidance.json"), JSON.stringify({ ...project, guidance }));
      const blocking = { target_changed_lines: 100, enforcement: "blocking" };
      writeFileSync(
        join(dir, "invalid.json"),
        JSON.stringify({ ...project, guidance: { ...project.guidance, pr_size: blocking } }),
      );
      for (const draft of ["unscored.json", "seeded.json"]) {
        expect(realAk(dir, draft, "no-guidance.json")).toEqual({ code: 1, err: GUIDANCE_ERROR });
        const invalid = realAk(dir, draft, "invalid.json");
        expect(invalid.code).toBe(1);
        expect(invalid.err.startsWith(`${SCHEMA_ERROR}: `)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(BOUND)("%s still stops on a project record that fails its schema, under every policy", (file) => {
    expect(flat(file)).toContain(
      "A present project record that fails schemas/project.schema.json validation is needs-input under every policy",
    );
  });

  test.each(BOUND)("%s records an unchecked record's validity as not checked, never as valid (AK9-2)", (file) => {
    const text = flat(file);
    expect(text).toContain(
      "with the ak delegation command missing, the unattended policy records its validity as not checked, never as valid",
    );
    expect(text).toContain(NOT_CHECKED);
  });

  test.each(BOUND)("%s keeps missing delegation guidance a needs-input stop outside the unattended policy", (file) => {
    expect(flat(file)).toContain("Outside the unattended policy, missing delegation guidance is needs-input");
  });

  test("step 6 keeps the CLI prerequisite outside the unattended policy and makes a missing command the limit under it", () => {
    const text = flat("skills/super-bound/SKILL.md");
    expect(text).toContain("A current agent-kit CLI is a prerequisite");
    expect(text).toContain(
      "outside the unattended policy a missing command, or a usage error from an older CLI, is reported as needs-input naming that prerequisite",
    );
    expect(text).toContain("under the unattended policy it is a delegation coverage limit (Inputs)");
    expect(text).not.toContain(
      "prerequisite: a missing command, or a usage error from an older CLI, is reported as needs-input",
    );
    expect(flat("skills/super-bound/skill.yaml")).toContain("a current ak on PATH outside the unattended policy");
  });

  test("SKILL.md never invents scorer inputs and skips the scorer steps under the limit", () => {
    const text = flat("skills/super-bound/SKILL.md");
    expect(text).not.toContain("Missing it is needs-input");
    expect(text).toContain("Scorer inputs are never invented");
    expect(text).not.toContain("this step runs nothing");
    expect(text.split("readiness and assumptions are still persisted").length - 1).toBeGreaterThanOrEqual(2);
    expect(text).toContain("except an unscored ticket under a delegation coverage limit");
  });

  test("skill.yaml no longer requires the project record at the schema level and grades the new contract", () => {
    const raw = readFileSync(join(REPO, "skills/super-bound/skill.yaml"), "utf8");
    const input = raw.match(/- id: project-guidance\n(?: {4}.*\n)+/)?.[0] ?? "";
    expect(input).toContain("required: false");
    const ids = [...raw.matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toContain("unattended-without-project-record-continues-unscored");
    expect(ids).toContain("invalid-project-record-stops");
    expect(ids).toContain("unattended-record-without-guidance-continues-unscored");
    expect(ids).toContain("unattended-without-ak-command-continues-unscored");
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
    expect(text).toContain(
      "no project record, a valid one without delegation guidance, or a missing ak delegation command",
    );
    expect(text).toContain(MISSING_COMMAND);
    expect(text).toContain(NOT_CHECKED);
    expect(text).toContain("never stops a phase");
    expect(text).toContain(UNSCORED);
    expect(text).toContain("a project record that fails schemas/project.schema.json validation");
    expect(text).toContain("build still declares the implementer seat, so self-verification is still refused");
  });

  test("the delegation reference treats an unscored ticket as a coverage limit, not a missing scorer run", () => {
    const text = flat("references/delegation/REFERENCE.md");
    expect(text).toContain("Under the unattended policy only, a delegation coverage limit");
    expect(text).toContain(
      "no project record, a valid one without delegation guidance, or a missing ak delegation command",
    );
    expect(text).toContain(MISSING_COMMAND);
    expect(text).toContain(NOT_CHECKED);
    expect(text).toContain("is not a missing scorer run and never stops a phase");
    expect(text).toContain(UNSCORED);
    expect(text).toContain(
      "A project record that fails schemas/project.schema.json validation stops under every policy",
    );
    expect(text).toContain(UNSCORED_FULL);
    expect(text).toContain("every required sensitive action still stops");
    expect(text).toContain(
      "A present project record is decided by ak delegation, never by hand, whether or not the draft ticket carries a delegation block",
    );
    expect(text).toContain("build records no class but still declares the implementer seat");
    expect(text).toContain(NO_SEED);
    expect(text).toContain(TICKET_SIDE);
  });
});

/** A sentence that requires the delegation block on every ticket, or names the exact delegation output a ticket carries. */
const REQUIRES_DELEGATION =
  /(?:every|each) (?:implementation )?ticket[^.;]*?(?:three evidence blocks|exact (?:successful )?(?:scorer output|ak delegation output))|exact ticket-time delegation (?:output|record)/i;
/** The unscored exception, stated in the same sentence. */
const UNSCORED_EXCEPTION = /delegation coverage limit|unscored/i;

/** Sentences of a flattened file that require the delegation block with no unscored exception. */
function requiresDelegationWithoutException(text: string): string[] {
  return text
    .split(/(?<=[.;])\s+|\s-\s/)
    .filter((sentence) => REQUIRES_DELEGATION.test(sentence) && !UNSCORED_EXCEPTION.test(sentence));
}

describe("no sentence still requires the delegation block of an unscored ticket", () => {
  test("the check catches the requirement wording it guards against", () => {
    expect(
      requiresDelegationWithoutException("complete — every implementation ticket carries the three evidence blocks."),
    ).toHaveLength(1);
    expect(
      requiresDelegationWithoutException("one per slice, with readiness and the exact ticket-time delegation output."),
    ).toHaveLength(1);
    expect(
      requiresDelegationWithoutException(
        "every implementation ticket carries the three evidence blocks, or, unscored under a delegation coverage limit, readiness and assumptions.",
      ),
    ).toEqual([]);
  });

  test.each([...BOUND, "references/delegation/REFERENCE.md", "references/unattended-lifecycle/REFERENCE.md"])(
    "%s",
    (file) => {
      expect(requiresDelegationWithoutException(flat(file))).toEqual([]);
    },
  );
});

describe("downstream readers accept an unscored ticket under the unattended policy", () => {
  test("super-build records no class for an unscored ticket but still declares its implementer seat", () => {
    const text = flat("skills/super-build/SKILL.md");
    expect(text).toContain(
      "An unscored ticket (the delegation reference's coverage limit) is built the same way with no class recorded",
    );
    expect(text).not.toContain("omit the four flags");
    expect(text).toContain(
      "An unscored ticket has no class to pass: declare the seat with --author-kind <human|agent> --host <host adapter id> --seat-id <implementer seat> and no --class",
    );
    expect(text).toContain("never a derived one or a seeded default");
    expect(readFileSync(join(REPO, "skills/super-build/skill.yaml"), "utf8")).toMatch(/^version: 0\.4\.0$/m);
  });

  test("super-ship states the class as unscored instead of deriving one", () => {
    const text = flat("skills/super-ship/SKILL.md");
    expect(text).toContain("An unscored ticket's class is stated as unscored with its coverage limit, never derived");
    expect(text).toContain(
      "in place of the sensitive factors the payload lists its attached packs and required sensitive actions and states that the delegation floor was not evaluated",
    );
  });

  test("the ticket schema keeps an unscored ticket valid without a delegation block", () => {
    const schemas = compileSchemas(REPO);
    const validateTicket = schemas.validatorFor("ticket");
    const validateProject = schemas.validatorFor("project");
    if (validateTicket === undefined || validateProject === undefined) throw new Error("schemas did not compile");
    const unscored = {
      ...unscoredTicket,
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

describe("an unscored ticket still carries criteria and named verification, and verify falls back without them", () => {
  test.each(BOUND)("%s records the ticket with criteria and verification derived from the work source", (file) => {
    expect(flat(file).toLowerCase()).toContain(
      "every implementation ticket, scored or unscored, is still recorded with acceptance criteria and named verification derived from the work source (the issue text or plan); scores and receipts are never invented",
    );
  });

  test.each(["skills/super-verify/SKILL.md", "skills/super-verify/skill.yaml"])(
    "%s makes a ticket with neither a coverage limit verified by the recorded repository checks",
    (file) => {
      const text = flat(file);
      expect(text).toContain(
        "Under the unattended policy, a ticket that declares no acceptance criteria and no verification at all is a coverage limit, never needs-input: record it once naming its cause and verify with the repository checks actually run, the project's declared test command among them when it declares one (its verification recipes, schemas/project.schema.json).",
      );
      expect(text).toContain(
        "declaring itself with --author-kind, --host and --seat-id; the build's implementer seat is refused",
      );
      expect(text).toContain(
        "The gate counts those checks and nothing else, and records the limit on its ship decision and in the ship disclosure. A ticket that declares criteria or verification the gate cannot read is judged like any other. Outside the policy it is unavailable.",
      );
    },
  );

  test("the unattended reference agrees, and super-verify's contract version moves with it", () => {
    const text = flat("references/unattended-lifecycle/REFERENCE.md");
    expect(text).toContain(
      "Bound still records every ticket, scored or unscored, with acceptance criteria and named verification derived from the work source (the issue text or plan)",
    );
    expect(text).toContain("the project's declared test command among them when it declares one");
    expect(text).toContain(
      "The gate counts those checks and nothing else, refuses a verify recorded by the build's implementer seat, and records the limit on its ship decision and in the ship disclosure. A ticket that declares criteria or verification the gate cannot read is judged like any other. Outside the policy it is unavailable.",
    );
    expect(readFileSync(join(REPO, "skills/super-verify/skill.yaml"), "utf8")).toMatch(/^version: 0\.4\.0$/m);
  });
});

/** A sentence naming the cause: no project record, missing delegation or project guidance, or an unscored ticket. */
const CAUSE =
  /no project record|(?:absent|missing|without a) project record|project record is (?:absent|missing)|(?:no|without a) delegation (?:class|block)|(?:missing|without) (?:project|delegation) guidance|delegation guidance (?:is )?missing|project (?:delegation )?guidance(?: or a grant)? is missing|missing (?:or unknown )?ak delegation command|ak delegation command (?:is )?(?:missing|absent|unavailable)|(?:no|without an?) ak delegation command|delegation coverage limit|delegation unscored|unscored ticket/i;
/** The phrasings that say the limit does not stop, and "block" as a noun, removed before a stop is looked for. */
const NOT_A_STOP =
  /never stops?|does not stop|do not stop|not stop(?:ping)?(?: for it)?|without stopping|stops nothing|(?:never|rather than) a stop|is not one(?: either)?|## stop conditions|(?:delegation|every|evidence) blocks?|blocking edges?/gi;
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
    expect(stopsOnDelegationLimit("Without a project record, super-ship refuses.")).toHaveLength(1);
    expect(stopsOnDelegationLimit("A missing ak delegation command is needs-input.")).toHaveLength(1);
    expect(stopsOnDelegationLimit("With no ak delegation command, bound stops.")).toHaveLength(1);
    expect(stopsOnDelegationLimit("A missing project record is needs-input.")).toHaveLength(1);
    expect(stopsOnDelegationLimit("When the ticket has no delegation class, verify stops.")).toHaveLength(1);
    expect(stopsOnDelegationLimit("A ticket without a delegation block stops at build.")).toHaveLength(1);
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

/**
 * The scaffolded workspace's premise, with no policy in the environment: its resolved policy, whether
 * project.json is absent, valid or invalid, and what the real `ak delegation` and the scaffold's
 * repository-local `ak` stub each report for it on an unscored draft ticket. The two must agree.
 */
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
    const stub = existsSync(join(tmp, "ak"));
    if (!existsSync(path)) return { policy, record: "absent" as const, stub };
    const validateProject = compileSchemas(REPO).validatorFor("project");
    const valid = validateProject?.(JSON.parse(readFileSync(path, "utf8"))) === true;
    writeFileSync(join(tmp, "ticket.json"), JSON.stringify(unscoredTicket));
    const run = spawnSync("./ak", ["delegation", "ticket.json", "--project", "project.json"], {
      cwd: tmp,
      encoding: "utf8",
    });
    return {
      policy,
      record: valid ? ("valid" as const) : ("invalid" as const),
      stub,
      real: realAk(tmp, "ticket.json", "project.json"),
      fake: { code: run.status, err: (run.stderr ?? "").trim() },
    };
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
    expect(c.text).toContain("floor not evaluated");
    expect(c.graders).toContain("no-scorer-run");
    expect(c.graders).toContain("no-project-record-invented");
    expect(premise("unattended-without-project-record-continues-unscored")).toEqual({
      policy: "unattended",
      record: "absent",
      stub: false,
    });
  });

  test("an unattended run with a valid record without delegation guidance runs the scorer and continues unscored", () => {
    const c = load("unattended-record-without-guidance-continues-unscored");
    expect(c.text).toContain("does not stop");
    expect(c.text).not.toMatch(/stops with needs-input/);
    expect(c.text).toContain("delegation unscored");
    expect(c.text).toContain("floor not evaluated");
    expect(c.graders).toContain("runs-the-scorer");
    expect(c.graders).toContain("project-record-unchanged");
    const p = premise("unattended-record-without-guidance-continues-unscored");
    expect(p).toMatchObject({ policy: "unattended", record: "valid", stub: true });
    expect(p.real).toEqual({ code: 1, err: GUIDANCE_ERROR });
    expect(p.fake).toEqual(p.real);
  });

  test("an unattended run with no ak delegation command continues unscored and records validity not checked", () => {
    const c = load("unattended-without-ak-command-continues-unscored");
    expect(c.text).toContain("does not stop");
    expect(c.text).not.toMatch(/stops with needs-input/);
    expect(c.text).toContain("validity not checked");
    expect(c.text).toContain("only node <bundle>/bin/ak-gate.mjs");
    expect(c.graders).toContain("project-record-unchanged");
    expect(c.graders).toContain("ticket-says-it-is-unscored");
    expect(premise("unattended-without-ak-command-continues-unscored")).toMatchObject({
      policy: "unattended",
      record: "valid",
      stub: false,
    });
  });

  test("an unattended run with an invalid project record stops", () => {
    const c = load("invalid-project-record-stops");
    expect(c.text).toContain("The response stops with needs-input");
    expect(c.text).toContain("not a coverage limit");
    expect(c.graders).toContain("no-ticket-written");
    expect(c.graders).toContain("runs-the-scorer");
    const p = premise("invalid-project-record-stops");
    expect(p).toMatchObject({ policy: "unattended", record: "invalid", stub: true });
    expect(p.real?.code).toBe(1);
    expect(p.real?.err.startsWith(`${SCHEMA_ERROR}: `)).toBe(true);
    expect(p.fake).toEqual(p.real);
  });
});
