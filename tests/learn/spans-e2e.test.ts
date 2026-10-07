/**
 * Run spans across the real CLI: one scratch project where every judge role
 * fires, driven through `runLearn` with the command judge pointed at a stub.
 * Every judge row must name a span the same command wrote, telemetry must
 * leave no seeded text behind, and a broken span file must change nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLearn } from "../../src/learn/cli.ts";
import { loadConfig } from "../../src/learn/core/config.ts";
import type { JudgeTraceRow } from "../../src/learn/core/judge.ts";
import { projectFolderName } from "../../src/learn/core/paths.ts";
import { Ledger } from "../../src/learn/core/ledger.ts";
import { readJsonl } from "../../src/learn/core/store.ts";
import { SPAN_FILE, type SpanRow } from "../../src/learn/core/trace.ts";
import { appendRun, ensureMemoryLedger, memoryDir, saveState, writeLesson } from "../../src/learn/memory/ledger.ts";
import { rollbackWiki } from "../../src/learn/memory/cli.ts";
import { UNDONE_RUNS_FILE } from "../../src/learn/memory/episodes.ts";
import { reviewLedger } from "../../src/learn/review/ledger.ts";
import { gitRepo, MemFixture, projectScratch, removeProjectScratch, scratch, stubRoles } from "./helpers.ts";

afterAll(removeProjectScratch);

const SECRET = "AKIACANARYSECRET9F3E";
const CORRECTION = "no, that is wrong: always run canarycorrection7c1d before pushing";
const NARRATIVE = "canarynarrative51ab the deploy key lives in the vault";
const REPO_NAME = "canaryrepo-zq81";
const ROLES = ["pattern-maintainer", "reflector", "consolidator", "lesson-merger", "skill-scout"] as const;

interface Project {
  root: string;
  env: Record<string, string>;
  runtimeDir: string;
}

/** One repository whose review, memory and skills loops each have work for the judge. */
function project(extraEnv: Record<string, string> = {}): Project {
  const base = scratch();
  const root = gitRepo(join(projectScratch(), REPO_NAME));
  const configDir = join(base, "config");
  const judge = join(base, "judge.sh");
  writeFileSync(
    judge,
    `cat > /dev/null\nprintf '%s\\n' '{"result":"{}","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":2}}'\n`,
  );
  const dbPath = join(base, "mem.db");
  const mem = new MemFixture(dbPath);
  const now = Date.now();
  const sid = "cccc3333-0000";
  mem.session({ sid, project: REPO_NAME, started: now - 86_400_000, completed: now - 86_400_000 + 1000 });
  const reflected = mem.observation({
    sid,
    project: REPO_NAME,
    type: "discovery",
    title: "found the deploy step",
    narrative: `${NARRATIVE} ${SECRET} ${root}/secrets.env`,
    at: now - 86_400_000 + 500,
  });
  mem.observation({ sid, project: REPO_NAME, type: "discovery", title: "found another", at: now - 86_400_000 + 600 });
  mem.toolUse({ sid, project: REPO_NAME, tool: "Bash", cwd: root, at: now - 86_400_000 + 500 });
  mem.close();
  const { TRACEPARENT: _ambient, ...inherited } = process.env;
  const env = {
    ...Object.fromEntries(
      Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    CLAUDE_CONFIG_DIR: configDir,
    AK_LEARN_MEM_DB: dbPath,
    AK_LEARN_ROLES_DIR: stubRoles(join(base, "roles")),
    AK_LEARN_JUDGE: `sh ${judge}`,
    AK_LEARN_JUDGE_TIMEOUT_S: "30",
    ...extraEnv,
  };
  const memory = ensureMemoryLedger(memoryDir(loadConfig(env), root));
  saveState(memory, { last_obs_id_reflected: reflected });
  appendRun(memory, { job: "reflect", status: "ok", min_obs_id: reflected, max_obs_id: reflected });
  writeLesson(
    memory.path("lessons", "ls-001.md"),
    { id: "ls-001", statement: "never hand-edit dist/", status: "confirmed", confidence: "0.9" },
    "\n",
  );
  writeLesson(
    memory.path("lessons", "ls-002.md"),
    { id: "ls-002", statement: "never edit generated files", status: "confirmed", confidence: "0.8" },
    "\n",
  );
  memory.commit("seed");
  const transcripts = join(configDir, "projects", projectFolderName(root));
  mkdirSync(transcripts, { recursive: true });
  for (const [transcriptSid, lines] of [
    ["aaaa1111-0000", ["please ask the bot to re-review this PR", "and then fix the lint failures"]],
    ["bbbb2222-0000", ["pushed the fix, re-trigger the review bot", "check the CI result too please"]],
    ["dddd4444-0000", ["the bot review is stale, rerun it now", "the head moved after my rebase"]],
  ] as const) {
    writeFileSync(
      join(transcripts, `${transcriptSid}.jsonl`),
      lines.map((content) => `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`).join(""),
    );
  }
  return { root, env, runtimeDir: join(configDir, "agent-kit", "learn") };
}

interface Outcome {
  code: number;
  out: string[];
  err: string[];
}

async function learn(p: Project, argv: string[], stdin?: string): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
  const code = await runLearn(argv, { cwd: p.root, io, env: p.env, stdin });
  return { code, out, err };
}

/** The scripted session: a correction, then the review, memory and skills runs a Stop hook would detach. */
async function session(p: Project): Promise<Outcome[]> {
  return [
    await learn(p, ["hook", "prompt"], JSON.stringify({ cwd: p.root, prompt: CORRECTION })),
    await learn(p, ["review", "run", "--repo", p.root, "--no-github", "--no-mem"]),
    await learn(p, ["memory", "run", "--job", "all", "--repo", p.root]),
    await learn(p, ["skills", "run", "--repo", p.root]),
    await learn(p, ["hook", "session-start"], JSON.stringify({ cwd: p.root })),
  ];
}

function spans(p: Project): SpanRow[] {
  return readJsonl<SpanRow>(join(p.runtimeDir, SPAN_FILE));
}

function judgeRows(p: Project): JudgeTraceRow[] {
  return readJsonl<JudgeTraceRow>(join(p.runtimeDir, "judge-calls.jsonl"));
}

describe("run-id linkage", () => {
  test("every judge row of all five roles names a span the same session wrote, in that span's trace", async () => {
    const p = project();
    for (const outcome of await session(p)) expect(outcome.code).toBe(0);
    const byId = new Map(spans(p).map((row) => [row.span_id, row]));
    const rows = judgeRows(p);
    expect(new Set(rows.map((row) => row.role))).toEqual(new Set(ROLES));
    for (const row of rows) {
      expect(row.run_id).not.toBeNull();
      const owner = byId.get(row.run_id ?? "");
      expect(owner).toBeDefined();
      expect(row.trace_id).toBe(owner?.trace_id ?? "");
      expect(row.parent_span_id).toBe(row.run_id);
    }
    const expected: SpanRow["name"][] = [
      "hook.prompt",
      "review.run",
      "review.ingest",
      "review.maintain",
      "review.propose",
      "memory.tick",
      "memory.reflect",
      "memory.nightly",
      "memory.weekly",
      "skills.run",
      "skills.discover",
      "skills.uses",
      "hook.session-start",
    ];
    const names = new Set(spans(p).map((row) => row.name));
    for (const name of expected) expect(names.has(name)).toBe(true);
    const owner = new Map<string, SpanRow["name"]>([
      ["pattern-maintainer", "review.maintain"],
      ["reflector", "memory.reflect"],
      ["consolidator", "memory.nightly"],
      ["lesson-merger", "memory.weekly"],
      ["skill-scout", "skills.discover"],
    ]);
    for (const row of rows) expect(byId.get(row.run_id ?? "")?.name).toBe(owner.get(row.role));
  });

  test("the nightly and weekly run ids, commit subjects and rollback all carry the job's span id", async () => {
    const p = project();
    await session(p);
    const nightly = spans(p).find((row) => row.name === "memory.nightly");
    const weekly = spans(p).find((row) => row.name === "memory.weekly");
    if (nightly === undefined || weekly === undefined) throw new Error("expected nightly and weekly spans");
    const memory = new Ledger(memoryDir(loadConfig(p.env), p.root));
    const runs = readJsonl<{ job: string; id?: string }>(memory.path("runs.jsonl"));
    expect(runs.find((row) => row.job === "nightly")?.id).toBe(nightly.span_id);
    expect(runs.find((row) => row.job === "weekly")?.id).toBe(weekly.span_id);
    const subjects = memory.git(["log", "--format=%s"]).stdout;
    expect(subjects).toContain(`nightly ${nightly.span_id}:`);
    expect(subjects).toContain(`weekly ${weekly.span_id}`);
    expect(nightly.commit).toBe(
      memory.git(["log", "-1", "--format=%H", "--grep", `^nightly ${nightly.span_id}:`]).stdout.trim(),
    );
    const before = memory.git(["rev-parse", `${nightly.commit ?? ""}~1`]).stdout.trim();
    writeFileSync(memory.path("lessons.md"), "# Lessons\nchanged after the run\n");
    memory.commit("touch the wiki");
    expect(rollbackWiki(memory, before)).toStartWith("rolled back");
    const undone = readJsonl<{ run: string }>(memory.path(UNDONE_RUNS_FILE)).map((row) => row.run);
    expect(undone).toContain(nightly.span_id);
  });

  test("judge totals roll up: the review run carries its maintainer's calls and cost", async () => {
    const p = project();
    await session(p);
    const rows = spans(p);
    const maintain = rows.find((row) => row.name === "review.maintain");
    const run = rows.find((row) => row.name === "review.run");
    expect(maintain?.parent_span_id).toBe(run?.span_id ?? "");
    expect(maintain?.judge.calls).toBeGreaterThan(0);
    expect(run?.judge).toEqual(maintain?.judge);
    expect(run?.judge.cost_usd).toBeCloseTo(0.01 * (maintain?.judge.calls ?? 0));
  });

  test("an ambient carrier roots the whole session in its trace", async () => {
    const p = project({ TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    await session(p);
    const rows = spans(p);
    expect(new Set(rows.map((row) => row.trace_id))).toEqual(new Set(["4bf92f3577b34da6a3ce929d0e0e4736"]));
    for (const row of rows.filter((r) => r.parent_span_id === "00f067aa0ba902b7"))
      expect(["hook.prompt", "review.run", "memory.tick", "skills.run", "hook.session-start"]).toContain(row.name);
  });
});

describe("redaction by construction", () => {
  test("no seeded secret, correction, narrative, path or repository name reaches the span file or judge trace", async () => {
    const p = project();
    await session(p);
    const spanText = readFileSync(join(p.runtimeDir, SPAN_FILE), "utf8");
    // `project` is the judge trace's existing basename field and stays out of scope here (spec AC-8).
    const judgeText = judgeRows(p)
      .map(({ project: _project, ...row }) => JSON.stringify(row))
      .join("\n");
    for (const canary of [SECRET, "canarycorrection7c1d", "canarynarrative51ab", p.root, REPO_NAME, "secrets.env"]) {
      expect(spanText).not.toContain(canary);
      expect(judgeText).not.toContain(canary);
    }
  });
});

/** Two scratch projects differ only in their paths and the clock; everything else must match. */
function normalize(p: Project, outcome: Outcome): string[] {
  return [...outcome.out, ...outcome.err].map((line) =>
    line
      .replaceAll(projectFolderName(p.root), "<folder>")
      .replaceAll(p.root, "<root>")
      .replaceAll(p.env.CLAUDE_CONFIG_DIR ?? "", "<config>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/g, "<time>")
      .replace(/idle \d+s/g, "idle <n>s"),
  );
}

describe("best effort", () => {
  test("an unwritable span file and salt change no exit code and no output", async () => {
    const working = project();
    const broken = project();
    mkdirSync(join(broken.runtimeDir, SPAN_FILE), { recursive: true });
    mkdirSync(join(broken.runtimeDir, ".salt"), { recursive: true });
    const a = await session(working);
    const b = await session(broken);
    expect(b.map((o) => o.code)).toEqual(a.map((o) => o.code));
    expect(b.map((o) => normalize(broken, o))).toEqual(a.map((o) => normalize(working, o)));
  });
});

describe("session-start exposure", () => {
  test("the hook span lists exactly the guardrail and lesson ids in the printed block", async () => {
    const p = project();
    writeFileSync(
      reviewLedger(loadConfig(p.env), p.root).path("guardrails.md"),
      "# Guardrails\n\n- [rp-007] check the diff against the PR body\n",
    );
    const out = await learn(p, ["hook", "session-start"], JSON.stringify({ cwd: p.root }));
    const printed = out.out.join("\n");
    expect(printed).toContain("[rp-007]");
    expect(printed).toContain("[ls-001]");
    const row = spans(p).find((r) => r.name === "hook.session-start");
    expect(row?.attrs.shown).toEqual(["rp-007", "ls-001", "ls-002"]);
    expect(row?.attrs).toMatchObject({ guardrails: 1, lessons: 2 });
    expect(row?.project_key).toMatch(/^[0-9a-f]{12}$/);
  });
});
