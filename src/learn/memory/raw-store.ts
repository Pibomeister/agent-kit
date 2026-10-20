/**
 * The memory ledger's raw store: one SQLite file, `raw/learn.sqlite`, that git
 * never stages (`core/ledger.ts` `RAW_STORE_FILE`). Episodes, worker
 * observations and worker sessions are its tables. An episode or a worker
 * session is one row, and a refresh replaces that row, so the store keeps no
 * history of revisions. Raw rows are never rolled back, so they need no git
 * history; the wiki files beside them stay in git.
 *
 * Ledgers written before the store kept these rows in `episodes.jsonl`,
 * `raw/worker-observations.jsonl` and `raw/worker-sessions.jsonl`. The first
 * write reads those files once into the store and leaves them on disk; nothing
 * appends to them after that. Until that write, reads come from the files, so a
 * dry run, or a read of a ledger nobody has written, creates nothing.
 *
 * Every row is written behind the secret gate of the ledger it belongs to.
 */
import { Database } from "bun:sqlite";
import Ajv from "ajv";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { RAW_STORE_FILE } from "../core/ledger.ts";
import { gateJsonText, readJsonl } from "../core/store.ts";

/** The files the store replaced, relative to the ledger. Read once, by the first write, and never written. */
export const LEGACY_EPISODES_FILE = "episodes.jsonl";
export const LEGACY_OBSERVATIONS_FILE = "raw/worker-observations.jsonl";
export const LEGACY_SESSIONS_FILE = "raw/worker-sessions.jsonl";

const VERSION = 1;
const BUSY_MS = 5_000;

const SCHEMA = `
CREATE TABLE episodes (sid TEXT PRIMARY KEY, revisions INTEGER NOT NULL, marks TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE worker_observations (id INTEGER PRIMARY KEY, memory_session_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE worker_sessions (memory_session_id TEXT PRIMARY KEY, body TEXT NOT NULL);
`;

/** A consolidation mark an older ledger wrote on the episode row itself (`consolidated_run`). */
export interface LegacyMark {
  run: string;
  obs: number;
}

/** One episode as stored: its latest row, how many revisions it has had, and the marks older rows carried. */
export interface StoredEpisode<T> {
  row: T;
  revisions: number;
  marks: LegacyMark[];
}

interface EpisodeKey {
  sid: string;
  obs: number;
  consolidated_run?: string;
}

interface ObservationKey {
  id: number;
  memory_session_id: string;
}

interface SessionKey {
  memory_session_id: string;
}

export interface WorkerRows<O, S> {
  observations: O[];
  /** One row per session, the latest. */
  sessions: S[];
}

/**
 * Every body was written by this module from a row of the caller's type, through `JSON.stringify`, so
 * only its kind is checked on the way back: an object for a row, an array for a list of marks. Ajv
 * caches a compiled schema by the schema object, so `ROW_SCHEMA` compiles once.
 */
const bodyValidator = new Ajv({ strict: false });
const ROW_SCHEMA = { type: "object" };
const isMarks = bodyValidator.compile<LegacyMark[]>({ type: "array" });

function decode<T>(body: string, isBody: (value: unknown) => value is T): T {
  const value: unknown = JSON.parse(body);
  if (isBody(value)) return value;
  throw new Error(`${RAW_STORE_FILE}: a stored body is not the kind its table holds`);
}

function version(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}

/** The rows, serialized and passed through the secret gate as one text, so one write records one redaction. */
function gated(gate: string, label: string, rows: readonly unknown[]): string[] {
  if (rows.length === 0) return [];
  return gateJsonText(gate, label, rows.map((row) => JSON.stringify(row)).join("\n")).split("\n");
}

export class RawStore {
  readonly path: string;

  private constructor(readonly dir: string) {
    this.path = join(dir, RAW_STORE_FILE);
  }

  /** The store of the ledger at `dir`. Opening it touches nothing. */
  static of(dir: string): RawStore {
    return new RawStore(dir);
  }

  /** Episodes in the order each was first written. */
  episodes<T extends EpisodeKey>(): StoredEpisode<T>[] {
    const isRow = bodyValidator.compile<T>(ROW_SCHEMA);
    return this.read(
      (db) =>
        db
          .query<{ revisions: number; marks: string; body: string }, []>(
            "SELECT revisions, marks, body FROM episodes ORDER BY rowid",
          )
          .all()
          .map((row) => ({
            row: decode(row.body, isRow),
            revisions: row.revisions,
            marks: decode(row.marks, isMarks),
          })),
      () => this.legacyEpisodes<T>(),
    );
  }

  /** Insert each episode, or replace the row its session already has. */
  putEpisodes(rows: readonly EpisodeKey[], gate: string): void {
    if (rows.length === 0) return;
    const bodies = gated(gate, this.label("episodes"), rows);
    this.write((db) => {
      const upsert = db.query<unknown, [string, string]>(
        `INSERT INTO episodes (sid, revisions, marks, body) VALUES (?1, 1, '[]', ?2)
         ON CONFLICT (sid) DO UPDATE SET body = excluded.body, revisions = revisions + 1`,
      );
      rows.forEach((row, index) => upsert.run(row.sid, bodies[index] ?? ""));
    });
  }

  /** Worker observations by id, and the latest row of each worker session. */
  workers<O extends ObservationKey, S extends SessionKey>(): WorkerRows<O, S> {
    const isObservation = bodyValidator.compile<O>(ROW_SCHEMA);
    const isSession = bodyValidator.compile<S>(ROW_SCHEMA);
    return this.read(
      (db) => ({
        observations: db
          .query<{ body: string }, []>("SELECT body FROM worker_observations ORDER BY id")
          .all()
          .map((row) => decode(row.body, isObservation)),
        sessions: db
          .query<{ body: string }, []>("SELECT body FROM worker_sessions ORDER BY rowid")
          .all()
          .map((row) => decode(row.body, isSession)),
      }),
      () => this.legacyWorkers<O, S>(),
    );
  }

  /** Add observations and insert or replace session rows. Writes nothing, and creates no store, when both are empty. */
  addWorkers(observations: readonly ObservationKey[], sessions: readonly SessionKey[], gate: string): void {
    if (observations.length === 0 && sessions.length === 0) return;
    this.write((db) => this.insertWorkers(db, observations, sessions, gate));
  }

  /** Replace every worker row with these. */
  replaceWorkers(observations: readonly ObservationKey[], sessions: readonly SessionKey[], gate: string): void {
    this.write((db) => {
      db.exec("DELETE FROM worker_observations; DELETE FROM worker_sessions;");
      this.insertWorkers(db, observations, sessions, gate);
    });
  }

  private insertWorkers(
    db: Database,
    observations: readonly ObservationKey[],
    sessions: readonly SessionKey[],
    gate: string,
  ): void {
    const observationBodies = gated(gate, this.label("worker_observations"), observations);
    const insert = db.query<unknown, [number, string, string]>(
      "INSERT OR REPLACE INTO worker_observations (id, memory_session_id, body) VALUES (?1, ?2, ?3)",
    );
    observations.forEach((row, index) => insert.run(row.id, row.memory_session_id, observationBodies[index] ?? ""));
    const sessionBodies = gated(gate, this.label("worker_sessions"), sessions);
    const upsert = db.query<unknown, [string, string]>(
      `INSERT INTO worker_sessions (memory_session_id, body) VALUES (?1, ?2)
       ON CONFLICT (memory_session_id) DO UPDATE SET body = excluded.body`,
    );
    sessions.forEach((row, index) => upsert.run(row.memory_session_id, sessionBodies[index] ?? ""));
  }

  /** What a secret-redaction record names as the written file: the store and the table. */
  private label(table: string): string {
    return `${this.path}#${table}`;
  }

  private read<T>(query: (db: Database) => T, legacy: () => T): T {
    if (!existsSync(this.path)) return legacy();
    const db = new Database(this.path, { readwrite: true, create: false });
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
      return version(db) < VERSION ? legacy() : query(db);
    } finally {
      db.close();
    }
  }

  /** Run `change` in one write transaction, creating the store and importing the legacy files first when it is new. */
  private write(change: (db: Database) => void): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const db = new Database(this.path, { create: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
      db.transaction(() => {
        if (version(db) < VERSION) this.create(db);
        change(db);
      }).immediate();
    } finally {
      db.close();
    }
  }

  private create(db: Database): void {
    db.exec(SCHEMA);
    const episode = db.query<unknown, [string, number, string, string]>(
      "INSERT INTO episodes (sid, revisions, marks, body) VALUES (?1, ?2, ?3, ?4)",
    );
    for (const { row, revisions, marks } of this.legacyEpisodes<EpisodeKey>())
      episode.run(row.sid, revisions, JSON.stringify(marks), JSON.stringify(row));
    // Legacy rows passed the secret gate when they were appended, so they are stored as read.
    const { observations, sessions } = this.legacyWorkers<ObservationKey, SessionKey>();
    const observation = db.query<unknown, [number, string, string]>(
      "INSERT OR REPLACE INTO worker_observations (id, memory_session_id, body) VALUES (?1, ?2, ?3)",
    );
    for (const row of observations) observation.run(row.id, row.memory_session_id, JSON.stringify(row));
    const session = db.query<unknown, [string, string]>(
      "INSERT INTO worker_sessions (memory_session_id, body) VALUES (?1, ?2)",
    );
    for (const row of sessions) session.run(row.memory_session_id, JSON.stringify(row));
    db.exec(`PRAGMA user_version = ${VERSION}`);
  }

  /** The latest row of each episode in `episodes.jsonl`, in first-appearance order, with its revision count and row marks. */
  private legacyEpisodes<T extends EpisodeKey>(): StoredEpisode<T>[] {
    const out = new Map<string, StoredEpisode<T>>();
    for (const row of readJsonl<T>(join(this.dir, LEGACY_EPISODES_FILE))) {
      const previous = out.get(row.sid);
      const marks = previous?.marks ?? [];
      if (row.consolidated_run !== undefined) marks.push({ run: row.consolidated_run, obs: row.obs });
      out.set(row.sid, { row, revisions: (previous?.revisions ?? 0) + 1, marks });
    }
    return [...out.values()];
  }

  private legacyWorkers<O extends ObservationKey, S extends SessionKey>(): WorkerRows<O, S> {
    const sessions = new Map<string, S>();
    for (const row of readJsonl<S>(join(this.dir, LEGACY_SESSIONS_FILE))) sessions.set(row.memory_session_id, row);
    return {
      observations: readJsonl<O>(join(this.dir, LEGACY_OBSERVATIONS_FILE)).toSorted((a, b) => a.id - b.id),
      sessions: [...sessions.values()],
    };
  }
}
