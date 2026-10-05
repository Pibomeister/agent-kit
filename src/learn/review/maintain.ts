/**
 * The wiki maintainer: unprocessed raw events plus the index become created or
 * patched pattern pages, a rebuilt index, a log line and a repeat-rate row.
 *
 * The judge (role `pattern-maintainer`) only classifies and drafts text.
 * Every id it cites must be in its input or it is discarded; counts, statuses,
 * ids, the index table and the repeat rate are computed here from the ledger.
 */
import type { LearnContext } from "../core/context.ts";
import type { Ledger } from "../core/ledger.ts";
import type { PatchOp } from "../core/pages.ts";
import { patchBody } from "../core/pages.ts";
import { buildPrompt } from "../core/roles.ts";
import { type Candidate, contentKey, similarLine, similarTo } from "../core/similar.ts";
import { readJson, readText, todayUtc, writeJson } from "../core/store.ts";
import { loadEvents, type ReviewEvent } from "./events.ts";
import {
  addEvidence,
  impactRow,
  loadPatterns,
  logLine,
  newPattern,
  nextId,
  type Pattern,
  type PatternSpec,
  rebuildIndex,
  savePattern,
  section,
  str,
} from "./patterns.ts";

export const PROCESSED_FILE = "raw/.processed.json";

export const MAINTAINER_CONTRACT = `{"create_patterns": [{"tmp_id": "new-1", "title": "...", "problem": "...", "root_cause": "...", "fix": "...",
                      "team_target": null, "event_hashes": ["<hash of an input event>"]}],
 "update_patterns": [{"id": "rp-001 or a tmp_id", "op": "append|replace|insert_after", "target": "exact existing text or null",
                      "text": "...", "team_target": null}],
 "event_matches": [{"hash": "<hash of an input event>", "pattern_ids": ["rp-001", "new-1"]}],
 "append_log": "one line summarising what changed"}

- \`event_hashes\` and every \`hash\` must be hashes of events in "New events"; a create that cites any other hash is discarded.
- \`pattern_ids\` and update \`id\` must be existing pattern ids or a \`tmp_id\` created in this reply; others are ignored.
- \`fix\` is one imperative sentence usable as a guardrail bullet.
- \`team_target\` is a repo-relative path of a tracked team file, or null.
- Counts, statuses and ids are not yours to set; any such field is ignored.`;

const PATCH_OPS: ReadonlySet<string> = new Set(["append", "replace", "insert_after"]);

/**
 * One event as a fenced block. The fence is longer than any backtick run in the
 * text, so an event cannot close its own fence and speak outside it.
 */
export function formatEvent(event: ReviewEvent): string {
  const keys = [
    "hash",
    "source",
    "kind",
    "pr",
    "severity",
    "author",
    "path",
    "line",
    "in_reply_to",
    "obs_id",
    "ts",
  ] as const;
  const head = keys
    .values()
    .filter((key) => event[key] !== null && event[key] !== undefined)
    .map((key) => `${key}=${String(event[key])}`)
    .toArray()
    .join(" ");
  const body = (event.text ?? "").slice(0, 1500);
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}event ${head}\n${body}\n${fence}`;
}

export function maintainerPrompt(
  ctx: LearnContext,
  ledger: Ledger,
  patterns: ReadonlyMap<string, Pattern>,
  events: readonly ReviewEvent[],
): string {
  const listing = [...patterns.values()]
    .map((p) => `- ${p.id}: ${str(p.meta, "title")} — ${section(p.body, "Problem").slice(0, 200)}`)
    .join("\n");
  return buildPrompt(
    "pattern-maintainer",
    MAINTAINER_CONTRACT,
    [
      { title: "Current index", body: readText(ledger.path("index.md")) },
      { title: "Existing patterns (id: title — problem)", body: listing === "" ? "(none)" : listing },
      { title: "New events", body: events.map(formatEvent).join("\n\n") },
    ],
    ctx.env,
  );
}

export interface Tally {
  /** Findings and corrections classified this run; resolutions are context and never counted. */
  total: number;
  /** Findings that matched a pattern that existed before this run. */
  repeat: number;
  /** Findings that matched only patterns created this run. */
  fresh: number;
}

export interface ApplyState {
  patterns: Map<string, Pattern>;
  tally: Tally;
  /** event hash -> pattern ids it was counted against. */
  processed: Record<string, string[]>;
  newIds: Set<string>;
  /** Existing patterns a create restated, which counted its events instead of a duplicate page; once per create. */
  repeated: string[];
  /** Created patterns resembling an existing one, with the candidates a reviewer may amend or supersede. */
  similar: Array<{ id: string; candidates: Candidate[] }>;
  notes: string[];
  /** Why parts of a reply were discarded. Written to the log. */
  rejected: string[];
}

export function emptyState(patterns: Map<string, Pattern>): ApplyState {
  return {
    patterns,
    tally: { total: 0, repeat: 0, fresh: 0 },
    processed: {},
    newIds: new Set(),
    repeated: [],
    similar: [],
    notes: [],
    rejected: [],
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Any C0 control character or DEL: a line break in a single-line field could forge a frontmatter key. */
// oxlint-disable-next-line eslint/no-control-regex -- matching control characters is this pattern's whole purpose
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A repo-relative path, or null. Absolute paths, parent traversal and control characters are refused. */
function teamTarget(value: unknown): string | null {
  const target = text(value);
  if (target === "" || CONTROL.test(target) || target.startsWith("/") || target.split(/[\\/]/).includes(".."))
    return null;
  return target;
}

/** True when the reply has the one field every valid reply carries. */
export function validReply(reply: Record<string, unknown> | null): reply is Record<string, unknown> {
  return reply !== null && Array.isArray(reply.event_matches);
}

/**
 * Apply one judge reply to the in-memory pages. Only bookkeeping computed here
 * reaches a page: the reply supplies classification and prose, nothing else.
 */
export function applyReply(
  ctx: LearnContext,
  ledger: Ledger,
  events: readonly ReviewEvent[],
  reply: Record<string, unknown>,
  state: ApplyState,
): void {
  const { patterns } = state;
  const byHash = new Map(events.map((event) => [event.hash, event]));
  const tmpMap = new Map<string, string>();

  for (const spec of records(reply.create_patterns)) {
    const fields: PatternSpec = {
      title: text(spec.title),
      problem: text(spec.problem),
      root_cause: text(spec.root_cause),
      fix: text(spec.fix),
      team_target: teamTarget(spec.team_target),
    };
    if (!fields.title || !fields.problem || !fields.root_cause || !fields.fix) {
      state.rejected.push(`create ${text(spec.tmp_id) || "?"}: missing title, problem, root_cause or fix`);
      continue;
    }
    const cited = strings(spec.event_hashes);
    const foreign = cited.filter((hash) => !byHash.has(hash));
    if (cited.length === 0 || foreign.length > 0) {
      state.rejected.push(
        `create ${text(spec.tmp_id) || "?"}: cites ${cited.length === 0 ? "no event" : `hashes not in the input (${foreign.join(", ")})`}`,
      );
      continue;
    }
    const key = contentKey(patternContent(fields), "");
    const same = [...patterns.values()].find((pattern) => contentKey(patternContent(pattern), "") === key);
    if (same !== undefined) {
      // A restated pattern is a repeat: its events count on the existing page and no second page is written.
      if (text(spec.tmp_id) !== "") tmpMap.set(text(spec.tmp_id), same.id);
      state.repeated.push(same.id);
      continue;
    }
    const pool = [...patterns.values()].map((pattern) => ({
      id: pattern.id,
      status: str(pattern.meta, "status"),
      text: `${str(pattern.meta, "title")}\n${patternContent(pattern)}`,
    }));
    const candidates = similarTo(`${fields.title}\n${patternContent(fields)}`, pool);
    const id = nextId(patterns);
    patterns.set(id, newPattern(ledger, id, fields, byHash.get(cited[0]!)!));
    if (text(spec.tmp_id) !== "") tmpMap.set(text(spec.tmp_id), id);
    state.newIds.add(id);
    if (candidates.length > 0) state.similar.push({ id, candidates });
  }

  for (const update of records(reply.update_patterns)) {
    const raw = text(update.id);
    const id = tmpMap.get(raw) ?? raw;
    const pattern = patterns.get(id);
    const body = typeof update.text === "string" ? update.text : "";
    if (pattern === undefined || body.trim() === "") {
      if (pattern === undefined) state.rejected.push(`update ${raw || "?"}: unknown pattern`);
      continue;
    }
    const op = text(update.op) || "append";
    if (!PATCH_OPS.has(op)) {
      state.rejected.push(`update ${id}: unknown op ${op}`);
      continue;
    }
    try {
      pattern.body = patchBody(
        pattern.body,
        op as PatchOp,
        typeof update.target === "string" ? update.target : "",
        body,
      );
    } catch (error) {
      logLine(ledger, `skipped patch on ${id}: ${(error as Error).message}`);
      continue;
    }
    const target = teamTarget(update.team_target);
    if (target !== null) pattern.meta.team_target = target;
  }

  const matches = new Map<string, string[]>();
  for (const match of records(reply.event_matches)) {
    const hash = text(match.hash);
    if (!byHash.has(hash)) {
      if (hash !== "") state.rejected.push(`match ${hash}: not an input event`);
      continue;
    }
    const ids = strings(match.pattern_ids);
    if (ids.length === 0 && typeof match.pattern_id === "string") ids.push(match.pattern_id);
    matches.set(
      hash,
      ids.map((id) => tmpMap.get(id) ?? id),
    );
  }
  for (const spec of records(reply.create_patterns)) {
    const id = tmpMap.get(text(spec.tmp_id));
    if (id === undefined) continue;
    for (const hash of strings(spec.event_hashes)) {
      const list = matches.get(hash) ?? [];
      if (!list.includes(id)) list.push(id);
      matches.set(hash, list);
    }
  }

  for (const event of events) {
    const ids = [...new Set(matches.get(event.hash) ?? [])].filter((id) => patterns.has(id));
    for (const id of ids) {
      const pattern = patterns.get(id)!;
      const next = addEvidence(pattern.meta, pattern.body, event, ctx.config.activeAt);
      pattern.meta = next.meta;
      pattern.body = next.body;
    }
    if (event.kind !== "resolution") {
      state.tally.total += 1;
      if (ids.some((id) => !state.newIds.has(id))) state.tally.repeat += 1;
      else if (ids.length > 0) state.tally.fresh += 1;
    }
    state.processed[event.hash] = ids;
  }
  const note = text(reply.append_log);
  if (note !== "") state.notes.push(note.replace(/\s+/g, " ").slice(0, 300));
}

/**
 * What a pattern says, without its title: problem, root cause and fix. A repeat
 * is matched on this, so a retitled restatement is still one pattern; the
 * project ledger the pattern lives in is its scope.
 */
export function patternContent(pattern: Pattern | PatternSpec): string {
  if ("body" in pattern) return ["Problem", "Root cause", "Fix"].map((name) => section(pattern.body, name)).join("\n");
  return [pattern.problem, pattern.root_cause, pattern.fix].join("\n");
}

/** `12%`: repeats over classified findings, floored. */
export function repeatRate(tally: Tally): string {
  return `${tally.total > 0 ? Math.floor((100 * tally.repeat) / tally.total) : 0}%`;
}

/**
 * Classify every unprocessed event in batches of `config.batch`, then write
 * pages, index, log, impact row and the processed map in one commit. The
 * caller holds the ledger lock.
 */
export function maintain(ctx: LearnContext, ledger: Ledger, project: string): string {
  const processed = readJson<Record<string, string[]>>(ledger.path(PROCESSED_FILE), {});
  const pending = loadEvents(ledger).filter((event) => !(event.hash in processed));
  if (pending.length === 0) return "no new events";
  const state = emptyState(loadPatterns(ledger));
  const size = Math.max(1, ctx.config.batch);

  if (ctx.config.dryRun) {
    ctx.io.out(maintainerPrompt(ctx, ledger, state.patterns, pending.slice(0, size)));
    return `dry run (${pending.length} unprocessed events, showing the first batch)`;
  }

  for (let i = 0; i < pending.length; i += size) {
    const chunk = pending.slice(i, i + size);
    const reply = ctx.judge(maintainerPrompt(ctx, ledger, state.patterns, chunk), {
      runId: null,
      loop: "review",
      role: "pattern-maintainer",
      project,
    });
    if (!validReply(reply)) {
      logLine(
        ledger,
        `maintainer: judge reply unusable on batch ${i / size + 1}; ${chunk.length} events left unprocessed`,
      );
      continue;
    }
    applyReply(ctx, ledger, chunk, reply, state);
  }
  for (const reason of state.rejected) logLine(ledger, `maintainer rejected: ${reason}`);
  for (const id of state.repeated) logLine(ledger, `maintainer: a create restated ${id}; counted there, no new page`);
  for (const { id, candidates } of state.similar)
    logLine(ledger, `similar ${similarLine(id, candidates)}: amend or supersede`);
  const done = Object.keys(state.processed).length;
  if (done === 0) {
    ledger.commit("maintain: judge reply unusable");
    return "judge reply unusable";
  }

  for (const pattern of state.patterns.values()) savePattern(pattern);
  const doneEvents = pending.filter((event) => event.hash in state.processed);
  const prs =
    [...new Set(doneEvents.filter((event) => event.pr).map((event) => String(event.pr)))].sort().join(",") || "-";
  const rate = repeatRate(state.tally);
  const { total, repeat, fresh } = state.tally;
  rebuildIndex(ledger, state.patterns, `| ${todayUtc()} | ${prs} | ${total} | ${repeat} | ${fresh} | ${rate} |`);
  logLine(
    ledger,
    `prs=${prs} events=${done} findings=${total} repeats=${repeat} new_patterns=${state.newIds.size} — ${state.notes.join(" / ")}`,
  );
  impactRow(ledger, "run", "-", `prs=${prs} findings=${total} repeats=${repeat}`);
  writeJson(ledger.path(PROCESSED_FILE), { ...processed, ...state.processed });
  ledger.commit(
    `maintain: ${prs === "-" ? "no-pr" : prs} +${done} events, ${state.newIds.size} new patterns, repeat ${rate}`,
  );
  const restated = state.repeated.length > 0 ? `; ${state.repeated.length} restated (${state.repeated.join(",")})` : "";
  const similar = state.similar.map(({ id, candidates }) => `; similar ${similarLine(id, candidates)}`).join("");
  return `processed ${done} events; ${state.newIds.size} new patterns${restated}; repeat rate ${rate}${similar}`;
}
