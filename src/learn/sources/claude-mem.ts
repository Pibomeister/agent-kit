/**
 * The first observation-source implementation: claude-mem's SQLite database,
 * opened read-only. `adapters/observation-source/CONTRACT.md` is the contract;
 * this file is one binding of it.
 *
 * Every query matches a project by `project = ? OR project LIKE '?/%'`, because
 * claude-mem records a worktree or subdirectory session as `<project>/<suffix>`.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
  /** From the joined session; null when the session row is missing. */
  platform_source: string | null;
}

export interface SessionRow {
  id: number;
  memory_session_id: string;
  platform_source: string;
  started_at_epoch: number;
  completed_at_epoch: number | null;
  observation_count: number;
}

export interface SummaryRow {
  memory_session_id: string;
  request: string | null;
  completed: string | null;
  next_steps: string | null;
}

export interface CwdRow {
  project: string;
  cwd: string;
  last_seen: number;
}

const OBSERVATION_COLUMNS = `o.id, o.memory_session_id, o.project, o.type, o.title, o.subtitle, o.narrative, o.facts,
  o.concepts, o.files_read, o.files_modified, o.discovery_tokens, o.created_at, o.created_at_epoch, s.platform_source`;

const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

export class ClaudeMemSource {
  private constructor(private readonly db: Database) {}

  /** Null when the database file does not exist; claude-mem is optional. */
  static open(path: string): ClaudeMemSource | null {
    if (!existsSync(path)) return null;
    return new ClaudeMemSource(new Database(path, { readonly: true }));
  }

  close(): void {
    this.db.close();
  }

  private args(project: string): [string, string] {
    return [project, `${project}/%`];
  }

  /** Distinct top-level project names, most recently active first. */
  listProjects(): string[] {
    const rows = this.db
      .query<{ name: string }, []>(
        "select substr(project, 1, instr(project || '/', '/') - 1) as name, max(created_at_epoch) as seen from observations group by name order by seen desc",
      )
      .all();
    return rows.map((row) => row.name);
  }

  lastActivityMs(project: string): number {
    const row = this.db
      .query<{ last: number | null }, [string, string]>(
        "select max(created_at_epoch) as last from observations where (project = ? or project like ?)",
      )
      .get(...this.args(project));
    return row?.last ?? 0;
  }

  /** Discovery tokens and observation count after the watermark id. */
  newTokensSince(project: string, afterId: number): { tokens: number; count: number } {
    const row = this.db
      .query<{ tokens: number; count: number }, [string, string, number]>(
        "select coalesce(sum(discovery_tokens), 0) as tokens, count(*) as count from observations where (project = ? or project like ?) and id > ?",
      )
      .get(...this.args(project), afterId);
    return { tokens: row?.tokens ?? 0, count: row?.count ?? 0 };
  }

  /** Observations after a watermark id and at or below `throughId` when given, oldest first unless `newestFirst`. */
  observationsSince(
    project: string,
    afterId: number,
    options: { sinceEpochMs?: number; newestFirst?: boolean; throughId?: number } = {},
  ): ObservationRow[] {
    const order = options.newestFirst === true ? "desc" : "asc";
    return this.db
      .query<ObservationRow, [string, string, number, number, number]>(
        `select ${OBSERVATION_COLUMNS} from observations o left join sdk_sessions s on s.memory_session_id = o.memory_session_id
         where (o.project = ? or o.project like ?) and o.id > ? and o.id <= ? and o.created_at_epoch >= ? order by o.id ${order}`,
      )
      .all(...this.args(project), afterId, options.throughId ?? Number.MAX_SAFE_INTEGER, options.sinceEpochMs ?? 0);
  }

  /** A project's observation ids at or below `throughId`, oldest first. */
  observationIds(project: string, throughId: number): number[] {
    return this.db
      .query<{ id: number }, [string, string, number]>(
        "select id from observations where (project = ? or project like ?) and id <= ? order by id",
      )
      .all(...this.args(project), throughId)
      .map((row) => row.id);
  }

  /** The observations with these ids, oldest first. Unknown ids are absent. */
  observationsById(ids: readonly number[]): ObservationRow[] {
    const out: ObservationRow[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      out.push(
        ...this.db
          .query<ObservationRow, number[]>(
            `select ${OBSERVATION_COLUMNS} from observations o left join sdk_sessions s on s.memory_session_id = o.memory_session_id
             where o.id in (${chunk.map(() => "?").join(", ")})`,
          )
          .all(...chunk),
      );
    }
    return out.sort((a, b) => a.id - b.id);
  }

  sessionObservations(memorySessionId: string): ObservationRow[] {
    return this.db
      .query<ObservationRow, [string]>(
        `select ${OBSERVATION_COLUMNS} from observations o left join sdk_sessions s on s.memory_session_id = o.memory_session_id
         where o.memory_session_id = ? order by o.id`,
      )
      .all(memorySessionId);
  }

  /** The memory session each observation id belongs to. Unknown ids are absent. */
  observationSessions(ids: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const rows = this.db
        .query<{ id: number; memory_session_id: string }, number[]>(
          `select id, memory_session_id from observations where id in (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk);
      for (const row of rows) out.set(row.id, row.memory_session_id);
    }
    return out;
  }

  /** Sessions started since `sinceMs` that have completed, or started before `staleBeforeMs` (abandoned). */
  sessions(project: string, sinceMs: number, staleBeforeMs: number): SessionRow[] {
    return this.db
      .query<SessionRow, [string, string, number, number]>(
        `select s.id, s.memory_session_id, s.platform_source, s.started_at_epoch, s.completed_at_epoch,
           (select count(*) from observations o where o.memory_session_id = s.memory_session_id) as observation_count
         from sdk_sessions s where (s.project = ? or s.project like ?) and s.memory_session_id is not null
           and s.started_at_epoch >= ? and (s.completed_at_epoch is not null or s.started_at_epoch < ?)
         order by s.started_at_epoch`,
      )
      .all(...this.args(project), sinceMs, staleBeforeMs);
  }

  latestSummary(memorySessionId: string): SummaryRow | null {
    return (
      this.db
        .query<SummaryRow, [string]>(
          "select memory_session_id, request, completed, next_steps from session_summaries where memory_session_id = ? order by id desc limit 1",
        )
        .get(memorySessionId) ?? null
    );
  }

  summaries(memorySessionIds: readonly string[]): SummaryRow[] {
    if (memorySessionIds.length === 0) return [];
    const marks = memorySessionIds.map(() => "?").join(", ");
    return this.db
      .query<SummaryRow, string[]>(
        `select memory_session_id, request, completed, next_steps from session_summaries where memory_session_id in (${marks}) order by id`,
      )
      .all(...memorySessionIds);
  }

  promptCount(sessionDbId: number): number {
    const row = this.db
      .query<{ n: number }, [number]>("select count(*) as n from user_prompts where session_db_id = ?")
      .get(sessionDbId);
    return row?.n ?? 0;
  }

  /** First user prompt per session, newest first. Feeds skill discovery when transcripts are unavailable. */
  sessionPrompts(
    project: string,
    sinceMs: number,
    limit = 200,
  ): Array<{ content_session_id: string; user_prompt: string }> {
    return this.db
      .query<{ content_session_id: string; user_prompt: string }, [string, string, number, number]>(
        `select content_session_id, user_prompt from sdk_sessions where (project = ? or project like ?)
         and user_prompt is not null and started_at_epoch >= ? order by id desc limit ?`,
      )
      .all(...this.args(project), sinceMs, limit);
  }

  /** Paths this session wrote, from tool use. Covers sessions whose observations carry no file list. */
  editedFiles(memorySessionId: string): string[] {
    const marks = EDIT_TOOLS.map(() => "?").join(", ");
    const rows = this.db
      .query<{ tool_input: string | null }, string[]>(
        `select tool_input from tool_uses where memory_session_id = ? and tool_name in (${marks})`,
      )
      .all(memorySessionId, ...EDIT_TOOLS);
    const out = new Set<string>();
    for (const row of rows) {
      try {
        const input = JSON.parse(row.tool_input ?? "{}") as { file_path?: unknown };
        if (typeof input.file_path === "string" && input.file_path !== "") out.add(input.file_path);
      } catch {
        // A malformed tool input carries no path.
      }
    }
    return [...out].sort();
  }

  /** Latest tool-use cwd per (project, cwd) since `sinceMs`. Drives project auto-discovery. */
  toolUseCwds(sinceMs: number): CwdRow[] {
    return this.db
      .query<CwdRow, [number]>(
        `select project, cwd, max(created_at_epoch) as last_seen from tool_uses
         where created_at_epoch > ? and cwd is not null and cwd != '' group by project, cwd order by last_seen`,
      )
      .all(sinceMs);
  }

  /** How many sessions read a path. Measures whether a candidate skill is ever used. */
  sessionsReading(path: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        "select count(distinct memory_session_id) as n from observations where files_read like ?",
      )
      .get(`%${path}%`);
    return row?.n ?? 0;
  }
}

/** JSON array columns (`facts`, `concepts`, `files_*`) as string arrays; anything else is empty. */
export function jsonList(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
