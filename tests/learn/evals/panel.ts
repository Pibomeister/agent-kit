/**
 * The reviewer panel that grades a subject's transcripts, and the human-label queue its
 * disagreements go to. Not a test file.
 *
 * Seating follows ruling `missing-supervisor-never-implementer` (policies/resolved-conflicts.yaml):
 * a seat that cannot be filled independently is unavailable, and it is never backfilled — not by
 * the subject, and not by a seat already sitting on the panel. Here that means a reviewer bound
 * like the subject (same model binding, or the subject's own id) is refused for that subject, a
 * reviewer bound like one already seated is refused as a duplicate judgment, and both are
 * reported `unavailable` rather than quietly swapped. A subject with no binding runs its host's
 * default, which no reviewer on that host can be shown to differ from, so those are refused too. With fewer independent reviewers than
 * `min-reviewers` the panel itself is unavailable and grades nothing: it fails closed when the
 * required evidence is absent (ruling `required-lane-failure-is-unavailable`).
 *
 * The queue is JSON lines. Every disagreement is appended with each reviewer's vote and a `label`
 * of null for a human to fill; labelled rows are the calibration set that `calibration` turns into
 * κ per reviewer pair and per reviewer against the human.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Matrix, Seat, Subject } from "./matrix.ts";
import type { PriceTable } from "./pricing.ts";
import { cleanEnv } from "./session.ts";
import { type KappaRow, kappaTable } from "./stats.ts";
import type { HostKind, SessionResult, TokenUsage } from "./subjects/types.ts";

export type SeatStatus = "seated" | "unavailable" | "unused";

export interface SeatDecision {
  reviewer: Seat;
  status: SeatStatus;
  reason?: string;
}

export interface Panel {
  subject: Subject;
  status: "available" | "unavailable";
  members: Seat[];
  seats: SeatDecision[];
  hosts: HostKind[];
  reason?: string;
}

/** Seat reviewers for `subject`, preferring hosts other than the subject's, then hosts not yet on the panel. */
export function buildPanel(matrix: Pick<Matrix, "reviewers" | "panels">, subject: Subject): Panel {
  const min = matrix.panels["min-reviewers"];
  const size = matrix.panels.size ?? Number.POSITIVE_INFINITY;
  const decisions = new Map<string, SeatDecision>();
  const candidates: Seat[] = [];
  for (const reviewer of matrix.reviewers) {
    if (reviewer.id === subject.id)
      decisions.set(reviewer.id, { reviewer, status: "unavailable", reason: "is the subject" });
    else if (reviewer.model === subject.model)
      decisions.set(reviewer.id, { reviewer, status: "unavailable", reason: `bound like subject ${subject.id}` });
    else if (subject.model === undefined && reviewer.host === subject.host) {
      decisions.set(reviewer.id, {
        reviewer,
        status: "unavailable",
        reason: `subject ${subject.id} runs the ${subject.host} default binding`,
      });
    } else candidates.push(reviewer);
  }
  const members: Seat[] = [];
  const rank = (r: Seat) => (members.some((m) => m.host === r.host) ? 2 : 0) + (r.host === subject.host ? 1 : 0);
  while (candidates.length > 0) {
    let best = 0;
    for (let i = 1; i < candidates.length; i++) if (rank(candidates[i]!) < rank(candidates[best]!)) best = i;
    const [next] = candidates.splice(best, 1);
    const reviewer = next!;
    const twin = members.find((m) => m.model === reviewer.model);
    if (twin !== undefined)
      decisions.set(reviewer.id, { reviewer, status: "unavailable", reason: `bound like ${twin.id}, already seated` });
    else if (members.length >= size) decisions.set(reviewer.id, { reviewer, status: "unused", reason: "panel full" });
    else {
      members.push(reviewer);
      decisions.set(reviewer.id, { reviewer, status: "seated" });
    }
  }
  const seats = matrix.reviewers.map((r) => decisions.get(r.id)!);
  const hosts = [...new Set(members.map((m) => m.host))];
  if (members.length < min) {
    return {
      subject,
      status: "unavailable",
      members,
      seats,
      hosts,
      reason: `${members.length} independent reviewer(s) for ${subject.id}, ${min} required`,
    };
  }
  return { subject, status: "available", members, seats, hosts };
}

export type Vote = "PASS" | "FAIL" | "invalid";

export interface Grade {
  item: string;
  subject: string;
  verdict: "PASS" | "FAIL" | "needs-human" | "unavailable";
  votes: Record<string, Vote>;
  reasons: Record<string, string>;
  /** By reviewer, the token usage its judge session reported; a reviewer whose host reported none has no entry. */
  usage: Record<string, TokenUsage>;
  /** By reviewer, the cost of its judge session, where the host reported one or the price table derived one. */
  cost_usd: Record<string, number>;
  reason?: string;
}

/** Ask one reviewer one judge prompt and return its reply text with what the session reported spending. */
export type Judge = (reviewer: Seat, prompt: string) => Promise<Pick<SessionResult, "reply" | "usage" | "costUsd">>;

export interface GradeOptions {
  /** Identifies the graded item in the queue: case, subject and run. */
  item: string;
  /** The human-label queue, JSON lines. */
  queue: string;
  judge?: Judge;
  /** The matrix's price table, from which the default judge derives a Codex session's cost. */
  prices?: PriceTable;
  /** Also queue every Nth unanimous item (by id hash), so κ is not measured on disagreements alone. */
  calibrateEvery?: number;
}

export interface QueueRow {
  item: string;
  subject: string;
  criteria: string;
  transcript: string;
  votes: Record<string, Vote>;
  reasons: Record<string, string>;
  panel_verdict: Grade["verdict"];
  /** Filled by a human: PASS or FAIL. */
  label: "PASS" | "FAIL" | null;
}

/** A transcript as the judge reads it: tool calls and messages in order, then the final reply. */
export function renderTranscript(transcript: SessionResult | string): string {
  if (typeof transcript === "string") return transcript;
  const lines = transcript.events.map((e) =>
    e.kind === "tool"
      ? `[tool ${e.name}] ${JSON.stringify(e.input).slice(0, 400)}`
      : e.kind === "user"
        ? `[user] ${e.text.slice(0, 400)}`
        : `[assistant] ${e.text}`,
  );
  return [...lines, `[final reply] ${transcript.reply}`].join("\n");
}

export function judgePrompt(transcript: string, criteria: string): string {
  return [
    "You are grading one transcript of an agent session against the criteria below. Judge only from the transcript;",
    "do not run tools or read files. PASS only if every criterion is met.",
    "",
    "<criteria>",
    criteria,
    "</criteria>",
    "",
    "<transcript>",
    transcript,
    "</transcript>",
    "",
    'Reply with only one JSON object: {"verdict": "PASS" or "FAIL", "reason": "one sentence"}',
  ].join("\n");
}

/** The verdict in a judge reply: the last JSON object carrying one, else `invalid`. */
export function parseVote(reply: string): { vote: Vote; reason: string } {
  const objects = reply.match(/\{[^{}]*\}/g) ?? [];
  for (const text of objects.toReversed()) {
    try {
      const value = JSON.parse(text) as { verdict?: unknown; reason?: unknown };
      const verdict = typeof value.verdict === "string" ? value.verdict.toUpperCase() : "";
      if (verdict === "PASS" || verdict === "FAIL")
        return { vote: verdict, reason: typeof value.reason === "string" ? value.reason : "" };
    } catch {
      continue;
    }
  }
  return { vote: "invalid", reason: reply.slice(0, 200) };
}

/** The default judge: one isolated, single-turn session on the reviewer's own host, in an empty directory. */
export const hostJudge =
  (prices?: PriceTable): Judge =>
  async (reviewer, prompt) => {
    const { adapterFor, runSubject } = await import("./subjects/index.ts");
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ak-judge-")));
    try {
      return await runSubject(
        adapterFor(reviewer.host),
        reviewer.id,
        reviewer.model,
        { prompt, cwd, env: cleanEnv(), timeoutMs: 180_000, maxTurns: 1 },
        prices,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };

function sampled(item: string, every: number | undefined): boolean {
  if (every === undefined || every < 1) return false;
  return Number.parseInt(createHash("sha256").update(item).digest("hex").slice(0, 8), 16) % every === 0;
}

/**
 * Grade one transcript. Unanimous PASS or FAIL is the verdict. Any disagreement, or a reply with no
 * readable verdict, is `needs-human` and goes to the queue. An unavailable panel grades nothing.
 */
export async function grade(
  panel: Panel,
  transcript: SessionResult | string,
  criteria: string,
  options: GradeOptions,
): Promise<Grade> {
  const base = { item: options.item, subject: panel.subject.id };
  if (panel.status === "unavailable")
    return {
      ...base,
      verdict: "unavailable",
      votes: {},
      reasons: {},
      usage: {},
      cost_usd: {},
      reason: panel.reason ?? "panel unavailable",
    };
  const text = renderTranscript(transcript);
  const prompt = judgePrompt(text, criteria);
  const judge = options.judge ?? hostJudge(options.prices);
  const sessions = await Promise.all(panel.members.map((m) => judge(m, prompt)));
  const votes: Record<string, Vote> = {};
  const reasons: Record<string, string> = {};
  const usage: Record<string, TokenUsage> = {};
  const cost_usd: Record<string, number> = {};
  panel.members.forEach((m, i) => {
    const session = sessions[i]!;
    const parsed = parseVote(session.reply);
    votes[m.id] = parsed.vote;
    reasons[m.id] = parsed.reason;
    if (session.usage !== undefined) usage[m.id] = session.usage;
    if (session.costUsd !== undefined) cost_usd[m.id] = session.costUsd;
  });
  const distinct = new Set(Object.values(votes));
  const only = distinct.size === 1 ? [...distinct][0]! : undefined;
  const verdict: Grade["verdict"] = only === "PASS" || only === "FAIL" ? only : "needs-human";
  if (verdict === "needs-human" || sampled(options.item, options.calibrateEvery)) {
    const row: QueueRow = {
      item: options.item,
      subject: panel.subject.id,
      criteria,
      transcript: text,
      votes,
      reasons,
      panel_verdict: verdict,
      label: null,
    };
    mkdirSync(dirname(options.queue), { recursive: true });
    appendFileSync(options.queue, `${JSON.stringify(row)}\n`);
  }
  const result: Grade = { ...base, verdict, votes, reasons, usage, cost_usd };
  if (verdict === "needs-human")
    result.reason =
      only === "invalid" || distinct.has("invalid") ? "a reviewer gave no readable verdict" : "reviewers disagree";
  return result;
}

export function readQueue(queue: string): QueueRow[] {
  if (!existsSync(queue)) return [];
  return readFileSync(queue, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as QueueRow);
}

/** κ over the labelled rows: every reviewer pair, and each reviewer against the human (rater `human`). `invalid` votes are left out. */
export function calibration(queue: string): { labelled: number; kappa: KappaRow[] } {
  const rows = readQueue(queue).filter((r) => r.label === "PASS" || r.label === "FAIL");
  const ratings: Record<string, Record<string, string>> = { human: {} };
  for (const row of rows) {
    ratings.human![row.item] = row.label!;
    for (const [reviewer, vote] of Object.entries(row.votes)) {
      if (vote === "invalid") continue;
      (ratings[reviewer] ??= {})[row.item] = vote;
    }
  }
  return { labelled: rows.length, kappa: kappaTable(ratings) };
}
