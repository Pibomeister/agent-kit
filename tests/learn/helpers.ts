/**
 * Shared scaffolding for the learning-runtime tests: a scratch config
 * directory, a scripted judge, a stub roles directory and a claude-mem
 * fixture database carrying only the columns the runtime reads.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/learn/core/config.ts";
import type { LearnContext } from "../../src/learn/core/context.ts";
import type { JudgeCallContext, JudgeFn } from "../../src/learn/core/judge.ts";
import { run } from "../../src/learn/core/proc.ts";
import { SECTIONS } from "../../src/learn/memory/ledger.ts";
import type { ReflectReply } from "../../src/learn/memory/reflect.ts";

/** A fresh directory with one canonical spelling (macOS `/var` is a symlink). */
export function scratch(prefix = "ak-learn-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Run a probe from `dir` without git discovering a repository above that scratch directory. */
export function withGitCeiling<T>(dir: string, probe: () => T): T {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dir;
  try {
    return probe();
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
}

/** A child directory whose own scratch root is git's discovery ceiling for the duration of `probe`. */
export function inOutsideRepo<T>(probe: (cwd: string) => T): T {
  const ceiling = scratch();
  const cwd = join(ceiling, "outside");
  mkdirSync(cwd);
  return withGitCeiling(ceiling, () => probe(cwd));
}

const projectScratches: string[] = [];

/**
 * A fresh directory for a fixture project that discovery must find. It sits
 * under the repository's `.work/`, not `tmpdir()`: on Linux that is `/tmp`,
 * which discovery skips as scratch space. Remove with `removeProjectScratch`.
 */
export function projectScratch(): string {
  const base = join(import.meta.dir, "..", "..", ".work");
  mkdirSync(base, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(base, "ak-learn-")));
  projectScratches.push(dir);
  return dir;
}

export function removeProjectScratch(): void {
  for (const dir of projectScratches.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const ROLE_IDS = ["pattern-maintainer", "reflector", "consolidator", "lesson-merger", "skill-scout"] as const;

/** A roles directory whose ROLE.md files are one line each, so tests never depend on catalog prose. */
export function stubRoles(dir: string): string {
  for (const id of ROLE_IDS) {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "ROLE.md"), `# learn/${id}\n\nStub role for tests.\n`);
  }
  return dir;
}

/** A git repository with one commit, usable as a project root. */
export function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(["git", "init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  run(["git", "add", "-A"], { cwd: dir });
  run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init", "--no-gpg-sign"], { cwd: dir });
  return dir;
}

export interface TestContext extends LearnContext {
  out: string[];
  err: string[];
  prompts: string[];
  judgeContexts: Array<JudgeCallContext | undefined>;
}

/**
 * A context rooted in scratch space. `replies` are returned by the judge in
 * order; a function reply sees the prompt. Every prompt is recorded.
 */
export function testContext(
  options: {
    cwd?: string;
    env?: Record<string, string>;
    replies?: Array<Record<string, unknown> | null | ((prompt: string) => Record<string, unknown> | null)>;
  } = {},
): TestContext {
  const base = scratch();
  const rolesDir = stubRoles(join(base, "roles"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Blanked so a test run inside one of these hosts never resolves the developer's real host home.
    FACTORY_HOME_OVERRIDE: "",
    GROK_HOME: "",
    KIMI_CODE_HOME: "",
    CLAUDE_CONFIG_DIR: join(base, "config"),
    AK_LEARN_MEM_DB: join(base, "no-claude-mem.db"),
    AK_LEARN_ROLES_DIR: rolesDir,
    ...options.env,
  };
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const judgeContexts: Array<JudgeCallContext | undefined> = [];
  const queue = [...(options.replies ?? [])];
  const judge: JudgeFn = (prompt, context) => {
    prompts.push(prompt);
    judgeContexts.push(context);
    const next = queue.shift();
    if (next === undefined) return null;
    return typeof next === "function" ? next(prompt) : next;
  };
  return {
    cwd: options.cwd ?? base,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    config: loadConfig(env),
    judge,
    env,
    out,
    err,
    prompts,
    judgeContexts,
  };
}

/**
 * A reflector reply every gate accepts: one bullet citing the newest
 * observation the prompt showed that is not in `flagged`, and a security note
 * for each flagged observation the prompt showed.
 */
export function reflectorReply(prompt: string, flagged: readonly number[] = []) {
  const shown = [...prompt.matchAll(/^obs:(\d+) /gm)].map((match) => Number(match[1]));
  const cited = shown.findLast((id) => !flagged.includes(id));
  const [first, ...rest] = SECTIONS;
  return {
    memory: `${first}\n${cited === undefined ? "" : `- seen [obs:${cited}]\n`}${rest.join("\n")}\n`,
    security_notes: flagged.flatMap((id) =>
      shown.includes(id) ? [{ obs: `obs:${id}`, kind: "instruction-in-data" }] : [],
    ),
  } satisfies ReflectReply;
}

/** A judge that answers the reflector with `reflectorReply` and every other role with an empty batch. */
export function reflectorOrEmptyJudge(prompt: string) {
  return prompt.includes("# learn/reflector") ? reflectorReply(prompt) : { lessons: [], review_events: [] };
}

/** The subset of claude-mem's schema the runtime reads. Column names match upstream exactly. */
const MEM_SCHEMA = `
create table sdk_sessions (
  id integer primary key autoincrement, content_session_id text not null, memory_session_id text unique,
  project text not null, platform_source text not null default 'claude', user_prompt text,
  started_at text not null default '', started_at_epoch integer not null, completed_at text,
  completed_at_epoch integer, status text not null default 'active');
create table observations (
  id integer primary key autoincrement, memory_session_id text not null, project text not null, text text,
  type text not null, title text, subtitle text, facts text, narrative text, concepts text, files_read text,
  files_modified text, prompt_number integer, discovery_tokens integer default 0,
  created_at text not null default '', created_at_epoch integer not null);
create table session_summaries (
  id integer primary key autoincrement, memory_session_id text not null, project text not null, request text,
  investigated text, learned text, completed text, next_steps text, files_read text, files_edited text, notes text,
  prompt_number integer, discovery_tokens integer default 0, created_at text not null default '',
  created_at_epoch integer not null default 0);
create table user_prompts (
  id integer primary key autoincrement, session_db_id integer, content_session_id text not null,
  prompt_number integer not null, prompt_text text not null, created_at text not null default '',
  created_at_epoch integer not null default 0);
create table tool_uses (
  id integer primary key autoincrement, tool_use_id text not null default '', content_session_id text not null default '',
  memory_session_id text, session_db_id integer, project text not null, platform_source text not null default 'claude',
  tool_name text not null, tool_input text, tool_response text, cwd text, created_at_epoch integer not null default 0);
`;

export class MemFixture {
  readonly db: Database;
  constructor(readonly path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(MEM_SCHEMA);
  }

  session(row: {
    sid: string;
    project: string;
    started: number;
    completed?: number | null;
    platform?: string;
    prompt?: string;
    content?: string;
  }): number {
    const result = this.db
      .query(
        "insert into sdk_sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at_epoch, completed_at_epoch, status) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.content ?? row.sid,
        row.sid,
        row.project,
        row.platform ?? "claude",
        row.prompt ?? null,
        row.started,
        row.completed ?? null,
        row.completed === undefined || row.completed === null ? "active" : "completed",
      );
    return Number(result.lastInsertRowid);
  }

  observation(row: {
    sid: string;
    project: string;
    type: string;
    title?: string;
    subtitle?: string;
    narrative?: string;
    facts?: string[];
    concepts?: string[];
    filesRead?: string[];
    filesModified?: string[];
    tokens?: number;
    at: number;
  }): number {
    const result = this.db
      .query(
        `insert into observations (memory_session_id, project, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, discovery_tokens, created_at, created_at_epoch)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sid,
        row.project,
        row.type,
        row.title ?? null,
        row.subtitle ?? null,
        row.narrative ?? null,
        JSON.stringify(row.facts ?? []),
        JSON.stringify(row.concepts ?? []),
        JSON.stringify(row.filesRead ?? []),
        JSON.stringify(row.filesModified ?? []),
        row.tokens ?? 0,
        new Date(row.at).toISOString(),
        row.at,
      );
    return Number(result.lastInsertRowid);
  }

  summary(row: { sid: string; project: string; request?: string; completed?: string; next?: string }): void {
    this.db
      .query(
        "insert into session_summaries (memory_session_id, project, request, completed, next_steps) values (?, ?, ?, ?, ?)",
      )
      .run(row.sid, row.project, row.request ?? null, row.completed ?? null, row.next ?? null);
  }

  prompt(row: { sessionDbId: number; content: string; n: number; text: string }): void {
    this.db
      .query(
        "insert into user_prompts (session_db_id, content_session_id, prompt_number, prompt_text) values (?, ?, ?, ?)",
      )
      .run(row.sessionDbId, row.content, row.n, row.text);
  }

  toolUse(row: {
    sid: string;
    project: string;
    tool: string;
    input?: Record<string, unknown>;
    cwd?: string;
    at: number;
  }): void {
    this.db
      .query(
        "insert into tool_uses (memory_session_id, project, tool_name, tool_input, cwd, created_at_epoch) values (?, ?, ?, ?, ?, ?)",
      )
      .run(row.sid, row.project, row.tool, JSON.stringify(row.input ?? {}), row.cwd ?? null, row.at);
  }

  close(): void {
    this.db.close();
  }
}
