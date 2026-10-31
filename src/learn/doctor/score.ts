/**
 * Scoring one condensed transcript, and the run's aggregate.
 *
 * The judge returns a label and a reason for each of the four rubrics in
 * `roles/learn/session-scorer/ROLE.md`. The runtime maps the label to its score,
 * so a judge cannot write a number, and a label outside the rubric is dropped
 * rather than guessed at. The label tables, the curve, the weights, the failure
 * threshold and the grade bands are the donor's (warpdotdev/common-skills
 * `skill-doctor`: `scorers/*.md`, `SKILL.md` step 3, `scripts/render_report.py`).
 */
import { buildPrompt } from "../core/roles.ts";
import type { LearnContext } from "../core/context.ts";
import { declaredUnavailable } from "../core/judge.ts";
import type { DoctorSession, SkillInfo } from "./collect.ts";
import { renderTranscript, truncate } from "./collect.ts";
import { judgeObject, object, text, type JsonObject, type JsonValue } from "./json.ts";

export const SCORERS = ["efficiency", "code_quality", "procedure_compliance", "verbosity"] as const;
export type Scorer = (typeof SCORERS)[number];

/** Each rubric's labels and the score each maps to. `null` means the session is excluded from that mean. */
export const LABEL_SCORES: Readonly<Record<Scorer, Readonly<Record<string, number | null>>>> = {
  efficiency: { highly_efficient: 1, mostly_efficient: 0.8, mostly_inefficient: 0.4, highly_inefficient: 0.2 },
  code_quality: { approve: 1, block: 0.2, insufficient_evidence: null },
  procedure_compliance: { fully_compliant: 1, mostly_compliant: 0.8, noncompliant: 0.2 },
  verbosity: { proportionate: 1, verbose: 0.2, terse: 0.1 },
};

/** A session fails when any applicable raw score is below this. */
export const FAIL_BELOW = 0.5;
/** The weights of the overall score, coverage last. */
export const WEIGHTS: Readonly<Record<Scorer | "skill_coverage", number>> = {
  efficiency: 0.25,
  code_quality: 0.25,
  procedure_compliance: 0.2,
  verbosity: 0.15,
  skill_coverage: 0.15,
};
const GRADES: ReadonlyArray<readonly [number, string]> = [
  [0.97, "A+"],
  [0.93, "A"],
  [0.9, "A-"],
  [0.87, "B+"],
  [0.83, "B"],
  [0.8, "B-"],
  [0.77, "C+"],
  [0.73, "C"],
  [0.7, "C-"],
  [0.6, "D"],
];
const REASON_CHARS = 600;

export interface ScorerResult {
  label: string;
  score: number | null;
  reason: string;
}

export interface SessionScore {
  key: string;
  host: DoctorSession["host"];
  skills_used: string[];
  corrections: number;
  /** `scored` when every rubric came back with a valid label; `unavailable` otherwise, with the reason. */
  status: "scored" | "unavailable";
  why?: string;
  results: Partial<Record<Scorer, ScorerResult>>;
  failed: boolean;
}

export const SESSION_SCORER_CONTRACT = `{
  "efficiency": {"label": "highly_efficient | mostly_efficient | mostly_inefficient | highly_inefficient", "reason": "<1-3 sentences>"},
  "code_quality": {"label": "approve | block | insufficient_evidence", "reason": "<1-3 sentences>"},
  "procedure_compliance": {"label": "fully_compliant | mostly_compliant | noncompliant", "reason": "<1-3 sentences>"},
  "verbosity": {"label": "proportionate | verbose | terse", "reason": "<1-3 sentences>"}
}
Each label is exactly one of the values listed for its rubric. A reason cites the transcript: a tool call, a message or a count. Never return a number; the runtime assigns the score.`;

function skillLines(session: DoctorSession, skills: readonly SkillInfo[]): string {
  const used = skills.filter((skill) => session.skills_used.includes(skill.name));
  if (used.length === 0) return "No installed skill was detected in this session.";
  return used.map((skill) => `- ${skill.name} (${skill.scope}): ${skill.description || "(no description)"}`).join("\n");
}

/** The prompt for one session: the role, the contract, the skills it used, and the transcript fenced as data. */
export function scorerPrompt(session: DoctorSession, skills: readonly SkillInfo[], env: NodeJS.ProcessEnv): string {
  return buildPrompt(
    "session-scorer",
    SESSION_SCORER_CONTRACT,
    [
      { title: "Skills detected in this session", body: skillLines(session, skills) },
      {
        title: "Condensed transcript",
        body: `\`\`\`text\n${renderTranscript(session).replaceAll("```", "'''")}\n\`\`\``,
      },
    ],
    env,
  );
}

/** One rubric's reply checked against its label table. */
function result(scorer: Scorer, value: JsonValue | undefined): ScorerResult | null {
  const reply = object(value);
  const label = text(reply?.label);
  const table = LABEL_SCORES[scorer];
  if (label === null || !Object.hasOwn(table, label)) return null;
  return {
    label,
    score: table[label] ?? null,
    reason: truncate(text(reply?.reason) ?? "", REASON_CHARS),
  };
}

/** A session's score from the judge's reply. Anything short of four valid labels is `unavailable`, never a zero. */
export function parseScore(session: DoctorSession, reply: JsonObject | null): SessionScore {
  const base = {
    key: session.key,
    host: session.host,
    skills_used: session.skills_used,
    corrections: session.stats.corrections,
  };
  const declared = declaredUnavailable(reply);
  if (reply === null || declared !== null)
    return { ...base, status: "unavailable", why: declared ?? "no usable reply", results: {}, failed: false };
  const results: Partial<Record<Scorer, ScorerResult>> = {};
  const missing: string[] = [];
  for (const scorer of SCORERS) {
    const checked = result(scorer, reply[scorer]);
    if (checked === null) missing.push(scorer);
    else results[scorer] = checked;
  }
  if (missing.length > 0)
    return { ...base, status: "unavailable", why: `invalid or missing: ${missing.join(", ")}`, results, failed: false };
  const failed = SCORERS.some((scorer) => {
    const score = results[scorer]?.score;
    return score !== null && score !== undefined && score < FAIL_BELOW;
  });
  return { ...base, status: "scored", results, failed };
}

/** Score every sampled session, one judge call each. */
export function scoreSessions(
  ctx: LearnContext,
  sessions: readonly DoctorSession[],
  skills: readonly SkillInfo[],
  project: string,
): SessionScore[] {
  return sessions.map((session) =>
    parseScore(
      session,
      judgeObject(ctx, scorerPrompt(session, skills, ctx.env), {
        runId: null,
        loop: "skills",
        role: "session-scorer",
        project,
      }),
    ),
  );
}

export function curve(score: number): number {
  return 0.5 + 0.5 * score;
}

export function gradeFor(score: number): string {
  return GRADES.find(([threshold]) => score >= threshold)?.[1] ?? "F";
}

export interface Aggregate {
  sessions_scored: number;
  sessions_unavailable: number;
  /** Raw rubric means; `code_quality` is null when no session showed enough of a change. */
  raw: Record<Scorer, number | null>;
  /** Curved rubric scores, literal coverage and the weighted overall, as the report shows them; null when no session was scored. */
  scores: Record<Scorer | "skill_coverage" | "overall", number> | null;
  /** Null when no session was scored: an outage is not a measurement. */
  grade: string | null;
  failed: string[];
  notes: string[];
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The donor's step 3. A rubric with no applicable session counts as 0.5 before the curve
 * and the report says so; coverage is the share of scored sessions that used an installed skill.
 * With no scored session there is nothing to curve, so there is no score and no grade.
 */
export function aggregate(scores: readonly SessionScore[], skillsFound: number): Aggregate {
  const scored = scores.filter((score) => score.status === "scored");
  const unavailable = scores.length - scored.length;
  const unavailableNotes =
    unavailable > 0 ? [`${unavailable} sampled session(s) could not be scored and are left out of every mean.`] : [];
  if (scored.length === 0)
    return {
      sessions_scored: 0,
      sessions_unavailable: unavailable,
      raw: { efficiency: null, code_quality: null, procedure_compliance: null, verbosity: null },
      scores: null,
      grade: null,
      failed: [],
      notes: unavailableNotes,
    };
  const notes: string[] = [];
  const rubricMean = (scorer: Scorer): number | null => {
    const values = scored.flatMap((score) => {
      const value = score.results[scorer]?.score;
      return value === null || value === undefined ? [] : [value];
    });
    const found = mean(values);
    if (found === null) notes.push(`No scored session gave enough evidence for ${scorer}; it counts as 0.5.`);
    return found;
  };
  const raw: Record<Scorer, number | null> = {
    efficiency: rubricMean("efficiency"),
    code_quality: rubricMean("code_quality"),
    procedure_compliance: rubricMean("procedure_compliance"),
    verbosity: rubricMean("verbosity"),
  };
  const skillCoverage =
    skillsFound === 0 ? 0 : scored.filter((score) => score.skills_used.length > 0).length / scored.length;
  const rubrics: Record<Scorer, number> = {
    efficiency: curve(raw.efficiency ?? 0.5),
    code_quality: curve(raw.code_quality ?? 0.5),
    procedure_compliance: curve(raw.procedure_compliance ?? 0.5),
    verbosity: curve(raw.verbosity ?? 0.5),
  };
  const overall =
    SCORERS.reduce((sum, scorer) => sum + WEIGHTS[scorer] * rubrics[scorer], 0) +
    WEIGHTS.skill_coverage * skillCoverage;
  return {
    sessions_scored: scored.length,
    sessions_unavailable: unavailable,
    raw,
    scores: { ...rubrics, skill_coverage: skillCoverage, overall },
    grade: gradeFor(overall),
    failed: scored.flatMap((score) => (score.failed ? [score.key] : [])),
    notes: [...notes, ...unavailableNotes],
  };
}
