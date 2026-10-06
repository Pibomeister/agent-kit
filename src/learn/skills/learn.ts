/**
 * skill-learn: recurring requests that no skill serves become skill drafts in
 * the skills ledger, and never anything more without a human.
 *
 * Discovery reads the project's recent sessions two ways: user messages from
 * host transcripts (claude-reflect's extractor, ported) and first prompts from
 * claude-mem. The `skill-scout` judge proposes candidates; deterministic gates
 * decide which survive. Every evidence entry must cite a session that was in
 * the input and quote words that session actually contains, and a candidate
 * needs three distinct sessions. The runtime assigns ids and counts.
 *
 * Candidates live in `<ledger>/candidates/<id>.md`, never in the repository.
 * Promotion is a human act: `promote` prints the draft as input to the
 * `writing-skills` skill and installs nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LearnContext } from "../core/context.ts";
import { Ledger } from "../core/ledger.ts";
import { loopDir, projectFolderName, reflectFolderName } from "../core/paths.ts";
import { buildPrompt, PACKAGE_ROOT } from "../core/roles.ts";
import { appendJsonl, nowIso, readJson, todayUtc, writeJson } from "../core/store.ts";
import { runOf, span, triggerOf } from "../core/trace.ts";
import { memProject } from "../review/ingest.ts";
import { ClaudeMemSource } from "../sources/claude-mem.ts";
import { catalogSkills, installedSkills, oneLine } from "./roster.ts";

export type CandidateStatus = "candidate" | "promoted" | "rejected";

export interface CandidateInfo {
  name: string;
  description: string;
  scope: "project" | "global";
  status: CandidateStatus;
  created: string;
  /** Distinct sessions whose evidence passed the gate. */
  evidence: number;
  confidence: "high" | "medium";
  /** Distinct claude-mem sessions that read the draft, measured by the runtime. */
  uses: number;
  promoted?: string;
}

export interface SkillRegistry {
  next: number;
  candidates: Record<string, CandidateInfo>;
  /** Names never to propose again. */
  rejected: string[];
  /** Transcript session id -> byte size when read; claude-mem session id -> -1. */
  seen_sessions: Record<string, number>;
  last_discover?: string;
}

export interface SessionSample {
  /** The short id the judge sees and must cite. */
  sid: string;
  messages: string[];
}

/** A judge-proposed candidate as parsed from the reply, before the gate. */
export interface ProposedCandidate {
  name: string;
  description: string;
  scope: string;
  intent: string;
  steps: string[];
  guardrails: string[];
  evidence: Array<{ session: string; quote: string }>;
  confidence: string;
}

const EMPTY_REGISTRY: SkillRegistry = { next: 1, candidates: {}, rejected: [], seen_sessions: {} };
const DEFAULT_DAYS = 14;
const MIN_SESSIONS = 3;
const DEBOUNCE_MS = 24 * 3600 * 1000;
const SESSIONS_CHAR_CAP = 120_000;
/** A quote shorter than this matches too many sessions to be evidence of anything. */
const MIN_QUOTE_CHARS = 20;
const MIN_QUOTE_WORDS = 4;
/** Every judge prompt carries this heading, so a judge call recorded by an observer is never read back as a user request. */
const JUDGE_MARK = "## Output contract (enforced by the runtime)";

export function skillsLedger(ctx: LearnContext, root: string): Ledger {
  return new Ledger(loopDir(ctx.config, root, "skills")).ensure(
    {
      "registry.json": `${JSON.stringify(EMPTY_REGISTRY, null, 1)}\n`,
      ".gitignore": ".lock*\n",
    },
    "init skills ledger",
  );
}

/** The ledger a pass works on: a dry run reads whatever is there and never creates it. */
function passLedger(ctx: LearnContext, root: string): Ledger {
  return ctx.config.dryRun ? new Ledger(loopDir(ctx.config, root, "skills")) : skillsLedger(ctx, root);
}

export function loadRegistry(ledger: Ledger): SkillRegistry {
  const raw = readJson<Partial<SkillRegistry>>(ledger.path("registry.json"), {});
  const registry: SkillRegistry = {
    next: typeof raw.next === "number" ? raw.next : 1,
    candidates: raw.candidates ?? {},
    rejected: raw.rejected ?? [],
    seen_sessions: raw.seen_sessions ?? {},
  };
  if (raw.last_discover !== undefined) registry.last_discover = raw.last_discover;
  return registry;
}

function saveRegistry(ledger: Ledger, registry: SkillRegistry): void {
  writeJson(ledger.path("registry.json"), registry);
}

/**
 * claude-reflect's `should_include_message`: system content, tool results and
 * session continuations are never user requests.
 */
export function shouldIncludeMessage(text: string): boolean {
  if (text.trim() === "") return false;
  const skip = [
    /^</,
    /^\[/,
    /^\{/,
    /tool_result/,
    /tool_use_id/,
    /<command-/,
    /<task-notification>/,
    /<system-reminder>/,
    /This session is being continued/,
    /^Analysis:/,
    /^\*\*/,
    /^ {3}-/,
  ];
  return !skip.some((pattern) => pattern.test(text));
}

/** claude-reflect's `extract_user_messages`: user turns of a JSONL transcript, meta turns and non-text parts dropped. */
export function extractUserMessages(transcript: string): string[] {
  let text: string;
  try {
    text = readFileSync(transcript, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: { type?: unknown; isMeta?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isMeta === true) continue;
    const content = entry.message?.content;
    if (typeof content === "string") {
      if (content !== "" && shouldIncludeMessage(content)) out.push(content);
    } else if (Array.isArray(content)) {
      for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
        if (
          item?.type === "text" &&
          typeof item.text === "string" &&
          item.text !== "" &&
          shouldIncludeMessage(item.text)
        )
          out.push(item.text);
      }
    }
  }
  return out;
}

/** A plausible request: not a fragment, not a paste, not a slash command. */
function usable(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.length > 12 && trimmed.length < 600 && !/^[<{[/]/.test(trimmed) && !trimmed.includes(JUDGE_MARK);
}

/**
 * Recent sessions not analysed before. Transcripts come from both folder
 * conventions under the config dir; the same session mirrored twice is read
 * once. claude-mem supplies the first prompt of sessions with no transcript.
 * Seen marks are written into `registry` and persisted only by the caller.
 */
export function gatherSessions(
  ctx: LearnContext,
  root: string,
  days: number,
  registry: SkillRegistry,
  force = false,
): SessionSample[] {
  const cutoffMs = Date.now() - days * 86_400_000;
  const files = new Map<string, { path: string; mtime: number; size: number }>();
  for (const folder of new Set([projectFolderName(root), reflectFolderName(root)])) {
    const dir = join(ctx.config.configDir, "projects", folder);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.mtimeMs >= cutoffMs) files.set(name, { path, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  const out: SessionSample[] = [];
  const seen = registry.seen_sessions;
  for (const [name, file] of [...files.entries()].sort((a, b) => a[1].mtime - b[1].mtime)) {
    const sid = name.slice(0, -".jsonl".length);
    if (!force && seen[sid] === file.size) continue;
    const messages = extractUserMessages(file.path)
      .map((m) => m.trim())
      .filter(usable);
    seen[sid] = file.size;
    if (messages.length < 2) continue;
    out.push({ sid: sid.slice(0, 8), messages: messages.slice(0, 25) });
  }
  const mem = ClaudeMemSource.open(ctx.config.memDb);
  if (mem !== null) {
    try {
      const have = new Set(out.map((sample) => sample.sid));
      for (const row of mem.sessionPrompts(memProject(ctx, root), cutoffMs)) {
        const sid = row.content_session_id;
        if (!sid || have.has(sid.slice(0, 8)) || (!force && seen[sid] !== undefined) || !usable(row.user_prompt))
          continue;
        out.push({ sid: sid.slice(0, 8), messages: [row.user_prompt.trim()] });
        have.add(sid.slice(0, 8));
        seen[sid] = -1;
      }
    } finally {
      mem.close();
    }
  }
  return out;
}

/** Skill names already served: catalog, installed, and every candidate ever proposed. */
export function existingSkills(
  ctx: LearnContext,
  root: string,
  packageRoot?: string,
): Array<{ name: string; description: string }> {
  const skills = [
    ...catalogSkills(packageRoot ?? PACKAGE_ROOT),
    ...installedSkills(join(ctx.config.configDir, "skills")),
    ...installedSkills(join(root, ".claude", "skills")),
  ];
  const byName = new Map<string, string>();
  for (const skill of skills) if (!byName.has(skill.name)) byName.set(skill.name, skill.description);
  return [...byName.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, description]) => ({ name, description }));
}

export const SKILL_SCOUT_CONTRACT = `{"candidates": [{
  "name": "lowercase-kebab, 2-4 words",
  "description": "what the skill does AND when to use it, in the words the user types",
  "scope": "project | global",
  "intent": "one sentence",
  "steps": ["concrete imperative step with the exact command or path seen"],
  "guardrails": ["a correction the user made more than once"],
  "evidence": [{"session": "<a session id from the inputs>", "quote": "<the user's words copied verbatim: at least 4 words, at most 160 characters>"}],
  "confidence": "high | medium | low"
}]}
Evidence must cite session ids exactly as given in the inputs and quote words that session contains.
A candidate needs evidence from at least ${MIN_SESSIONS} different sessions. Return {"candidates": []} when nothing qualifies.`;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

/** Shape-check the reply. Anything malformed is dropped whole. */
export function parseCandidates(reply: Record<string, unknown> | null): ProposedCandidate[] | null {
  if (reply === null || !Array.isArray(reply.candidates)) return null;
  const out: ProposedCandidate[] = [];
  for (const raw of reply.candidates as unknown[]) {
    if (raw === null || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string" || typeof c.description !== "string") continue;
    const evidence = Array.isArray(c.evidence)
      ? (c.evidence as unknown[]).flatMap((e) => {
          const item = e as { session?: unknown; quote?: unknown } | null;
          return item !== null &&
            typeof item === "object" &&
            typeof item.session === "string" &&
            typeof item.quote === "string"
            ? [{ session: item.session, quote: item.quote }]
            : [];
        })
      : [];
    out.push({
      name: c.name,
      description: c.description,
      scope: typeof c.scope === "string" ? c.scope : "global",
      intent: typeof c.intent === "string" ? c.intent : "",
      steps: strings(c.steps),
      guardrails: strings(c.guardrails),
      evidence,
      confidence: typeof c.confidence === "string" ? c.confidence : "low",
    });
  }
  return out;
}

export function kebabName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The evidence gate. Keeps only evidence whose session was in the input and
 * whose quote, of at least four words and twenty characters, that session
 * contains; at most one entry per session. Returns
 * null when the candidate fails: too few sessions, low confidence, or a name
 * that is empty, rejected, already a skill or already proposed.
 */
export function gateCandidate(
  candidate: ProposedCandidate,
  sessions: readonly SessionSample[],
  taken: ReadonlySet<string>,
): (ProposedCandidate & { name: string; confidence: "high" | "medium"; scope: "project" | "global" }) | null {
  const name = kebabName(candidate.name);
  if (name === "" || taken.has(name)) return null;
  if (candidate.confidence !== "high" && candidate.confidence !== "medium") return null;
  if (oneLine(candidate.description) === "") return null;
  const texts = new Map(sessions.map((s) => [s.sid, normalize(s.messages.join("\n"))]));
  const kept: Array<{ session: string; quote: string }> = [];
  const used = new Set<string>();
  for (const item of candidate.evidence) {
    const text = texts.get(item.session);
    const quote = normalize(item.quote);
    const substantial = quote.length >= MIN_QUOTE_CHARS && quote.split(" ").length >= MIN_QUOTE_WORDS;
    if (text === undefined || !substantial || used.has(item.session) || !text.includes(quote)) continue;
    used.add(item.session);
    kept.push({ session: item.session, quote: oneLine(item.quote).slice(0, 160) });
  }
  if (kept.length < MIN_SESSIONS) return null;
  return {
    ...candidate,
    name,
    description: oneLine(candidate.description),
    evidence: kept,
    confidence: candidate.confidence,
    scope: candidate.scope === "project" ? "project" : "global",
  };
}

/** The draft body: a SKILL.md a human can hand to `writing-skills`. */
export function renderDraft(candidate: ProposedCandidate & { name: string }, id: string, created: string): string {
  const steps = candidate.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  const guards = candidate.guardrails.map((g) => `- ${g}`).join("\n") || "None recorded.";
  const evidence = candidate.evidence.map((e) => `- session \`${e.session}\`: “${e.quote}”`).join("\n");
  return (
    `---\nname: ${candidate.name}\ndescription: ${oneLine(candidate.description)}\n---\n\n# ${candidate.name}\n\n${candidate.intent}\n\n` +
    `## Steps\n${steps}\n\n## Guardrails (from corrections)\n${guards}\n\n## Evidence\n${evidence}\n\n` +
    `*Candidate ${id}, proposed by skill-learn on ${created} from ${candidate.evidence.length} sessions (confidence ${candidate.confidence}). ` +
    `Unreviewed; it becomes a skill only when a human runs it through writing-skills.*\n`
  );
}

export interface DiscoverOptions {
  days?: number;
  force?: boolean;
  /** Where `catalog.yaml` lives; the package root by default. */
  packageRoot?: string;
}

/** One discovery pass. Returns a one-line summary; writes nothing on a dry run or a failed judge call. */
export function discover(ctx: LearnContext, root: string, options: DiscoverOptions = {}): string {
  const ledger = passLedger(ctx, root);
  const release = ctx.config.dryRun ? () => undefined : ledger.tryLock();
  if (release === null) {
    ctx.span?.status("locked", "lock-held");
    return "";
  }
  try {
    const registry = loadRegistry(ledger);
    const sessions = gatherSessions(ctx, root, options.days ?? DEFAULT_DAYS, registry, options.force === true);
    ctx.span?.attr("sessions", sessions.length);
    if (sessions.length < MIN_SESSIONS) {
      ctx.span?.status("nothing");
      return `only ${sessions.length} new sessions; nothing to analyse`;
    }
    const existing = existingSkills(ctx, root, options.packageRoot);
    let body = sessions
      .map((s) => `#### session ${s.sid}\n${s.messages.map((m) => `- ${m.slice(0, 300)}`).join("\n")}`)
      .join("\n\n");
    if (body.length > SESSIONS_CHAR_CAP) body = body.slice(0, SESSIONS_CHAR_CAP);
    const prompt = buildPrompt(
      "skill-scout",
      SKILL_SCOUT_CONTRACT,
      [
        {
          title: "Existing skills (never duplicate one)",
          body: existing.map((s) => `- ${s.name}: ${s.description.slice(0, 120)}`).join("\n") || "(none)",
        },
        { title: "Rejected names (never propose again)", body: registry.rejected.join(", ") || "(none)" },
        { title: `Sessions (${sessions.length}, repository ${basename(root)})`, body },
      ],
      ctx.env,
    );
    if (ctx.config.dryRun) {
      ctx.span?.status("dry-run");
      ctx.io.out(prompt);
      return "dry run";
    }
    const proposed = parseCandidates(
      ctx.judge(prompt, {
        ...runOf(ctx),
        loop: "skills",
        role: "skill-scout",
        project: basename(root),
      }),
    );
    if (proposed === null) {
      ctx.span?.status("failed", "no-judge-output");
      return "judge call failed (sessions left unmarked)";
    }
    ctx.span?.attr("proposed", proposed.length);

    const taken = new Set([
      ...existing.map((s) => s.name),
      ...registry.rejected,
      ...Object.values(registry.candidates).map((c) => c.name),
    ]);
    const made: string[] = [];
    const created = todayUtc();
    for (const raw of proposed) {
      const candidate = gateCandidate(raw, sessions, taken);
      if (candidate === null) continue;
      const id = `sk-${String(registry.next).padStart(3, "0")}`;
      registry.next += 1;
      taken.add(candidate.name);
      mkdirSync(ledger.path("candidates"), { recursive: true });
      writeFileSync(ledger.path("candidates", `${id}.md`), renderDraft(candidate, id, created));
      registry.candidates[id] = {
        name: candidate.name,
        description: candidate.description,
        scope: candidate.scope,
        status: "candidate",
        created,
        evidence: candidate.evidence.length,
        confidence: candidate.confidence,
        uses: 0,
      };
      made.push(`${id} ${candidate.name}`);
    }
    registry.last_discover = nowIso();
    saveRegistry(ledger, registry);
    appendJsonl(ledger.path("raw", "discover.jsonl"), [
      { at: registry.last_discover, sessions: sessions.length, proposed: proposed.length, kept: made },
    ]);
    ctx.span?.attr("kept", made.length);
    const sha = ledger.commit(`discover: ${made.length} candidates from ${sessions.length} sessions`);
    ctx.span?.commit(sha);
    return `analysed ${sessions.length} sessions; ${made.length} new candidates: ${made.join(", ") || "-"}`;
  } finally {
    release();
  }
}

/** Refresh each pending candidate's use count from claude-mem. Returns how many changed. */
export function measureUses(ctx: LearnContext, ledger: Ledger, registry: SkillRegistry): number {
  const mem = ClaudeMemSource.open(ctx.config.memDb);
  if (mem === null) return 0;
  let changed = 0;
  try {
    for (const [id, info] of Object.entries(registry.candidates)) {
      if (info.status !== "candidate") continue;
      const uses = mem.sessionsReading(ledger.path("candidates", `${id}.md`));
      if (uses !== info.uses) {
        info.uses = uses;
        changed += 1;
      }
    }
  } finally {
    mem.close();
  }
  return changed;
}

/**
 * The debounced entry (`skills run`, detached by the Stop hook): discovery at most once a day, then a use count for every
 * pending candidate. Nothing is promoted here; the use count is what a human
 * weighs when deciding to promote.
 */
export function runSkillLearn(ctx: LearnContext, root: string): string {
  return span(ctx, "skills.run", triggerOf(ctx, "cli"), (run) => {
    run.span?.project(root);
    return skillLearnRun(run, root);
  });
}

function skillLearnRun(ctx: LearnContext, root: string): string {
  const ledger = passLedger(ctx, root);
  const parts: string[] = [];
  const trigger = triggerOf(ctx, "cli");
  const last = loadRegistry(ledger).last_discover;
  if (last === undefined || Date.now() - Date.parse(last) > DEBOUNCE_MS) {
    const summary = span(ctx, "skills.discover", trigger, (inner) => {
      inner.span?.project(root);
      return discover(inner, root);
    });
    if (summary !== "") parts.push(summary);
  }
  if (ctx.config.dryRun) {
    ctx.span?.status("dry-run");
    return parts.join("; ");
  }
  span(ctx, "skills.uses", trigger, (inner) => {
    inner.span?.project(root);
    const release = ledger.tryLock();
    if (release === null) {
      inner.span?.status("locked", "lock-held");
      return;
    }
    try {
      const registry = loadRegistry(ledger);
      const changed = measureUses(inner, ledger, registry);
      if (changed > 0) {
        saveRegistry(ledger, registry);
        const sha = ledger.commit(`uses: ${changed} candidates measured`);
        inner.span?.commit(sha);
      }
      const pending = Object.values(registry.candidates).filter((c) => c.status === "candidate");
      inner.span?.attr("changed", changed);
      inner.span?.attr("pending", pending.length);
      ctx.span?.attr("pending", pending.length);
      parts.push(
        `${pending.length} candidates pending (${pending.map((c) => `${c.name}=${c.uses}`).join(", ") || "-"})`,
      );
    } finally {
      release();
    }
  });
  return parts.join("; ");
}

/** The draft as a `writing-skills` input, and the candidate marked as handed to a human. */
export function promoteCandidate(ctx: LearnContext, root: string, id: string): string | null {
  const ledger = skillsLedger(ctx, root);
  const registry = loadRegistry(ledger);
  const info = registry.candidates[id];
  const path = ledger.path("candidates", `${id}.md`);
  if (info === undefined || !existsSync(path)) return null;
  const draft = readFileSync(path, "utf8");
  if (info.status === "candidate" && !ctx.config.dryRun) {
    info.status = "promoted";
    info.promoted = todayUtc();
    saveRegistry(ledger, registry);
    ledger.commit(`promote ${id} ${info.name}: handed to writing-skills`);
  }
  return [
    `Input for the writing-skills skill: candidate ${id} (${info.name}), used by ${info.uses} sessions, evidence from ${info.evidence}.`,
    "Review it, rewrite it to the authoring contract, and install it only if it earns its place. Nothing has been installed.",
    "",
    draft.trimEnd(),
  ].join("\n");
}

/** Delete the draft and never propose its name again. */
export function rejectCandidate(ctx: LearnContext, root: string, id: string): boolean {
  const ledger = skillsLedger(ctx, root);
  const registry = loadRegistry(ledger);
  const info = registry.candidates[id];
  if (info === undefined) return false;
  if (ctx.config.dryRun) return true;
  info.status = "rejected";
  if (!registry.rejected.includes(info.name)) registry.rejected.push(info.name);
  rmSync(ledger.path("candidates", `${id}.md`), { force: true });
  saveRegistry(ledger, registry);
  ledger.commit(`reject ${id} ${info.name}`);
  return true;
}
