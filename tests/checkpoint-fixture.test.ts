import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { checkSchemas } from "../src/validation/schemas.ts";
import { loadCatalog } from "../src/catalog/load.ts";
import { makeTree } from "./helpers/tree.ts";
import { canonicalJson, sha256Hex, artifactHash } from "../src/util/hash.ts";
import { digestDomain, evidenceDigest } from "../src/validation/docrules.ts";

/**
 * The batch-5 checkpoint fixture, checked rather than described.
 *
 * The fixture's job is to let the checkpoint fail. Every assertion here exists
 * because the corresponding way of getting it wrong produces a fixture that
 * looks finished and grades nothing: artifacts that do not conform to the
 * schemas they are meant to exercise, a revision cited by the artifacts that
 * the repository does not actually have, a seeded defect whose tests pass
 * before it is fixed, a repair path with no refusal on it, and a repository
 * with somewhere to push.
 *
 * The state machine is the centre of it. A seeded defect that the obvious
 * repair fully fixes cannot host a refused closure, and a fixture where the
 * incomplete and complete repairs are indistinguishable returns the same answer
 * whether the delta verification is independent or not.
 */

const FIXTURE = join(import.meta.dir, "fixtures", "checkpoint");
const SCHEMAS_DIR = join(import.meta.dir, "..", "schemas");
const ISOLATION = join(FIXTURE, "stages", "finding", "tests", "isolation.checks.ts");
const TICKET_DONE = join(FIXTURE, "selftest", "ticket-done", "quota.ts");
const INCOMPLETE = join(FIXTURE, "selftest", "repair-incomplete", "report.ts");
const COMPLETE = join(FIXTURE, "selftest", "repair-complete", "report.ts");

function shippedSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(SCHEMAS_DIR)) {
    if (name.endsWith(".schema.json")) out[`schemas/${name}`] = readFileSync(join(SCHEMAS_DIR, name), "utf8");
  }
  return out;
}

const CATALOG = `schema_version: 1
package:
  id: ak
  name: agent-kit
  version: 0.1.0
  namespace: "/ak:"
  default_profile: core
schemas:
${readdirSync(SCHEMAS_DIR)
  .filter((n) => n.endsWith(".schema.json"))
  .map((n) => `  - id: ${n.replace(".schema.json", "")}\n    status: authored`)
  .join("\n")}
`;

const artifactNames = readdirSync(join(FIXTURE, "artifacts")).filter((n) => n.endsWith(".json"));
const artifacts = Object.fromEntries(
  artifactNames.map((n) => [
    n,
    JSON.parse(readFileSync(join(FIXTURE, "artifacts", n), "utf8")) as Record<string, unknown>,
  ]),
);

/** Materialize once; every git assertion reads the same throwaway repository. */
function materialize(): string {
  return execFileSync(join(FIXTURE, "materialize.sh"), [], { encoding: "utf8" }).trim();
}

type Outcome = { pass: number; fail: number; failing: string[] };

function runFixtureTests(work: string, target: string): Outcome {
  // Both streams: bun writes the run summary to stderr, so reading stdout
  // alone reports zero passes for every state that passed -- which reads as a
  // broken fixture rather than as a broken harness.
  const proc = spawnSync(process.execPath, ["test", target], { cwd: work, encoding: "utf8" });
  const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  if (out.trim() === "") throw new Error(`no output from the fixture run in ${work}`);
  const num = (re: RegExp) => Number(out.match(re)?.[1] ?? "0");
  return {
    pass: num(/(\d+) pass/),
    fail: num(/(\d+) fail/),
    failing: [...out.matchAll(/\(fail\) (.+?) \[/g)].map((m) => m[1]!),
  };
}

function materializeState(files: Record<string, string>): string {
  // Materialize rather than copy `repo/`. The layout a state runs against has
  // to be the one materialize.sh produces -- including the rename that keeps
  // the fixture's own checks out of this repository's test collector -- and a
  // copy made here would be a second spelling of that layout that diverges
  // the first time either moves. It already did: this harness reported an
  // empty state machine when the copy kept a name the materializer changes.
  const work = materialize();
  for (const [rel, from] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), readFileSync(from, "utf8"));
  }
  return work;
}

const repo = materialize();
const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const stateRepos = {
  ticket: materializeState({ "src/quota.ts": TICKET_DONE, "tests/isolation.test.ts": ISOLATION }),
  incomplete: materializeState({
    "src/quota.ts": TICKET_DONE,
    "src/report.ts": INCOMPLETE,
    "tests/isolation.test.ts": ISOLATION,
  }),
  complete: materializeState({
    "src/quota.ts": TICKET_DONE,
    "src/report.ts": COMPLETE,
    "tests/isolation.test.ts": ISOLATION,
  }),
};

// Every subprocess runs once here, outside the timed test bodies. A nested Bun
// run takes tens of seconds on a loaded machine, so one inside a test body is
// what the per-test timeout measures instead of the fixture.
const outcomes = {
  before: runFixtureTests(repo, "tests/quota.test.ts"),
  ticketAcceptance: runFixtureTests(stateRepos.ticket, "tests/quota.test.ts"),
  ticketIsolation: runFixtureTests(stateRepos.ticket, "tests/isolation.test.ts"),
  incompleteIsolation: runFixtureTests(stateRepos.incomplete, "tests/isolation.test.ts"),
  completeIsolation: runFixtureTests(stateRepos.complete, "tests/isolation.test.ts"),
  completeAll: runFixtureTests(stateRepos.complete, "tests/"),
};

const second = materialize();
const secondHead = execFileSync("git", ["-C", second, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
rmSync(second, { recursive: true, force: true });

const lane = join(repo, "tools", "security-lane.sh");
// The lane runs tests/isolation.test.ts, which exists only once a ticket state adds it: run it where the
// defect is present and where it is fixed, so its exit status is the isolation check's and not bun's
// "no matching test files".
const runLane = (work: string) =>
  spawnSync(join(work, "tools", "security-lane.sh"), [], {
    encoding: "utf8",
    env: { ...process.env, BUN: process.execPath },
  });
const laneDefault = runLane(stateRepos.ticket);
const laneFixed = runLane(stateRepos.complete);
const laneUnavailable = spawnSync(lane, [], {
  encoding: "utf8",
  env: { ...process.env, BUN: process.execPath, CHECKPOINT_SECURITY_LANE: "unavailable" },
});

// The schema pass runs here for the same reason: compiling every shipped
// schema is seconds of CPU on a loaded machine, and inside a test body that is
// what the per-test timeout measures.
const schemaRoot = makeTree({
  "catalog.yaml": CATALOG,
  ...shippedSchemas(),
  ...Object.fromEntries(artifactNames.map((n) => [`templates/${n}`, JSON.stringify(artifacts[n])])),
});
const schemaErrors = checkSchemas({ root: schemaRoot, catalog: loadCatalog(schemaRoot).catalog! })
  .filter((i) => i.severity === "error" && i.file.startsWith("templates/"))
  .map((i) => `${i.file}: ${i.message}`);

afterAll(() => {
  for (const work of Object.values(stateRepos)) rmSync(work, { recursive: true, force: true });
});

describe("the fixture's artifacts conform to the schemas they exercise", () => {
  test("every artifact validates", () => {
    expect(schemaErrors).toEqual([]);
  });

  test("the charter's approval binds to the charter it approved", () => {
    const charter = artifacts["charter.json"]!;
    const approvals = charter["approvals"] as Array<Record<string, unknown>>;
    expect(approvals[0]!["artifact_hash"]).toBe(artifactHash(charter));
  });

  test("the charter's own digest is the one it carries", () => {
    const charter = JSON.parse(JSON.stringify(artifacts["charter.json"])) as Record<string, unknown>;
    const declared = (charter["immutability"] as Record<string, unknown>)["hash"];
    delete charter["approvals"];
    (charter["immutability"] as Record<string, unknown>)["hash"] = "";
    expect(declared).toBe(artifactHash(charter));
  });
});

describe("the artifacts and the repository agree about the revision", () => {
  // An artifact citing a revision the repository does not have cites nothing,
  // and the failure is silent: every schema check still passes.
  test("every revision the artifacts cite is the materialized head", () => {
    const cited = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v === null || typeof v !== "object") return;
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (k === "revision" && typeof child === "string") cited.add(child);
        else walk(child);
      }
    };
    for (const name of artifactNames) walk(artifacts[name]);
    expect(cited.size).toBeGreaterThan(0);
    expect([...cited]).toEqual([head]);
  });

  test("the path the materializer prints is the one its own tools report", () => {
    // On macOS a mktemp directory has two names -- /var/folders/... and
    // /private/var/folders/..., because /var is a symlink -- and tools print
    // the resolved one. A stage that asks git where the repository is and
    // compares the answer to the path it was handed then finds a mismatch with
    // no other symptom, and the checkpoint fails for a reason that is not
    // about the slice. The materializer resolves before it prints; this is
    // what says so, because nothing else here would notice.
    expect(execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()).toBe(repo);
  });

  test("materializing twice produces the same revision", () => {
    expect(secondHead).toBe(head);
  });
});

describe("the fixture repository has nowhere to push", () => {
  // super-ship is dry-run only. This is the difference between "we did not
  // push" and "we could not have pushed", and it is the one the plan's hard
  // boundary actually asks for.
  test("no remote is configured", () => {
    expect(execFileSync("git", ["-C", repo, "remote"], { encoding: "utf8" }).trim()).toBe("");
  });

  test("no remote configuration of any kind survives materialization", () => {
    const config = execFileSync("git", ["-C", repo, "config", "--list"], { encoding: "utf8" });
    const reaching = config.split("\n").filter((line) => /^remote\.|insteadof|pushurl/i.test(line));
    expect(reaching).toEqual([]);
  });
});

describe("the fixture can host a refused closure", () => {
  // The centre of the fixture. Each state is the previous one plus one file,
  // and what makes the fixture worth anything is that states 3 and 4 differ:
  // the repair a reader of the finding makes turns the first isolation check
  // green and leaves the second red. A fixture where the obvious repair closed
  // the finding would grade a run that never checked independently exactly the
  // same as one that did.
  test("state 1: the ticket's own checks are red before the change", () => {
    const r = outcomes.before;
    expect(r.pass).toBe(0);
    expect(r.fail).toBe(2);
  });

  test("state 2: the change satisfies the ticket and does not touch the defect", () => {
    const acceptance = outcomes.ticketAcceptance;
    expect(acceptance.fail).toBe(0);
    expect(acceptance.pass).toBe(2);

    const isolation = outcomes.ticketIsolation;
    expect(isolation.fail).toBe(2);
  });

  test("state 3: the repair the finding points at leaves the independent check red", () => {
    const r = outcomes.incompleteIsolation;
    expect(r.pass).toBe(1);
    expect(r.fail).toBe(1);
    // Named, not counted: which one stays red is the whole content of the state.
    expect(r.failing).toEqual(["the summary's widest limit belongs to a tenant in the request"]);
  });

  test("state 4: a complete repair closes it", () => {
    const r = outcomes.completeAll;
    expect(r.fail).toBe(0);
    expect(r.pass).toBe(4);
  });

  test("the two isolation checks are not the same check", () => {
    // If the incomplete repair satisfied both, the fixture would have no
    // refusal on it and this whole block would be measuring nothing.
    expect(outcomes.incompleteIsolation.fail).toBeGreaterThan(outcomes.completeIsolation.fail);
  });
});

interface EvidenceEntry {
  location: { path: string; line_range: { start: number } };
  excerpt: string;
}

interface Fingerprint {
  inputs: { evidence_digest: string };
  value: string;
}

describe("the findings point at what they say they point at", () => {
  const findings = artifactNames.filter((n) => n.startsWith("finding."));

  test("every excerpt is at the line its evidence claims, in the materialized repository", () => {
    const wrong: string[] = [];
    for (const name of findings) {
      const evidence = artifacts[name]!["evidence"] as EvidenceEntry[];
      for (const [i, entry] of evidence.entries()) {
        const { path, line_range } = entry.location;
        const lines = readFileSync(join(repo, path), "utf8").split("\n");
        const actual = lines[line_range.start - 1];
        if (actual !== entry.excerpt) {
          wrong.push(
            `${name} evidence[${i}] claims ${path}:${line_range.start} is ${JSON.stringify(entry.excerpt)}, found ${JSON.stringify(actual)}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every excerpt occurs exactly once in its file, so the line is not what identifies it", () => {
    const ambiguous: string[] = [];
    for (const name of findings) {
      for (const entry of artifacts[name]!["evidence"] as EvidenceEntry[]) {
        const lines = readFileSync(join(repo, entry.location.path), "utf8").split("\n");
        const hits = lines.filter((l) => l === entry.excerpt).length;
        if (hits !== 1) ambiguous.push(`${name}: ${JSON.stringify(entry.excerpt)} occurs ${hits} times`);
      }
    }
    expect(ambiguous).toEqual([]);
  });

  test("moving the quoted line does not change the fingerprint", () => {
    // Release scenario 9, made drivable rather than asserted. The staged file
    // is the same defect with two comment lines added above it, so the excerpt
    // and the path are what they were and the position is not. The domain is
    // read from schemas/finding.schema.json and recomputed with the function
    // the validator recomputes with: this test used to project the evidence
    // itself, and that copy went stale the moment the domain gained a member,
    // which is the whole argument for there being one of them.
    const finding = artifacts["finding.tenant-isolation.json"]!;
    const fingerprint = finding["fingerprint"] as Fingerprint;
    const inputs = fingerprint.inputs;
    const excerpt = (finding["evidence"] as EvidenceEntry[])[0]!.excerpt;

    const moved = readFileSync(join(FIXTURE, "stages", "line-move", "report.ts"), "utf8").split("\n");
    const before = readFileSync(join(repo, "src/report.ts"), "utf8").split("\n");
    const lineBefore = before.findIndex((l) => l === excerpt) + 1;
    const lineAfter = moved.findIndex((l) => l === excerpt) + 1;
    expect(lineBefore).toBeGreaterThan(0);
    expect(lineAfter).toBeGreaterThan(lineBefore);

    // The digest the finding carries is a digest of its evidence over the
    // stated domain, and the moved line is not in that domain.
    const domain = digestDomain(join(import.meta.dir, ".."));
    expect(domain).not.toBeNull();
    expect(domain!.fields.some((f) => /line|offset/i.test(f))).toBe(false);
    expect(evidenceDigest(finding, domain!)).toBe(inputs.evidence_digest);
    expect(`sha256:${sha256Hex(canonicalJson(inputs))}`).toBe(fingerprint.value);
  });
});

describe("a required lane can be made unavailable", () => {
  test("the lane runs and reports the defect by default", () => {
    expect(outcomes.ticketIsolation.failing.length).toBeGreaterThan(0);
    expect(laneDefault.status).toBe(1);
    expect(`${laneDefault.stdout}${laneDefault.stderr}`).toContain(
      `(fail) ${outcomes.ticketIsolation.failing[0] ?? "(none)"}`,
    );
    expect(laneFixed.status).toBe(0);
  });

  test("the switch makes it unavailable, distinguishably from finding something", () => {
    // 70, not 1: a lane that cannot tell "the tool is missing" from "the tool
    // found a problem" turns one into the other, and scenario 4 is exactly
    // about not letting the first read as the second.
    expect(laneUnavailable.status).toBe(70);
    expect(laneUnavailable.stderr).toContain("unavailable");
  });
});
