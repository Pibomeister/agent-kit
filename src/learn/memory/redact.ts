/**
 * The reflector's security channel and the quarantine gate.
 *
 * An observation can carry an instruction aimed at the agent. The reflector
 * reports one in `security_notes` as an id and a kind from a closed
 * vocabulary; it never writes the attack in prose (reflector never-rule 5).
 * Those ids are the quarantine. A bullet that describes an instruction aimed
 * at the agent adds the shown observations it cites, as a backstop for a reply
 * that reports in prose instead; wording is never the primary signal, because
 * an adopted payload carries no warning words.
 *
 * The runtime then drops every bullet citing a quarantined observation, scans
 * every remaining bullet of the whole memory, whatever section it sits in and
 * whatever it cites, for text only a quarantined observation holds, and writes
 * one aggregated security bullet from runtime data only: the ids, their
 * sessions and the kinds. The observation's title, subtitle and facts are never
 * copied, because the observer wrote them and they can carry the payload.
 *
 * A real fact that shares a quarantined observation is lost with it for this
 * run. That fails closed: the runtime cannot tell which half of one observation
 * is the payload, and a later observation that restates the fact cites cleanly.
 *
 * Matching is keyed on uniqueness across the inputs, never on the shape of a
 * payload, and runs on normalized words: Unicode compatibility forms folded,
 * format characters and accents removed, lowercased, split on anything that is
 * not a letter or a digit. So case, punctuation, spacing and a payload split
 * across two bullets all match. A fragment is distinctive when a quarantined
 * observation holds it and no clean observation, session summary, the previous
 * memory or the output contract's headings do. The observer that wrote the
 * observation also summarized its session, so the summary of a session holding
 * a quarantined observation is tainted text, never clean. Three kinds are
 * scanned:
 *   marked   a token of 6+ characters with a digit, dot, slash, dash or
 *            underscore (a URL, host, path, flag or identifier), as its word
 *            sequence and, from 8 letters and digits up, run together
 *   phrase   three consecutive content words, one of them in no clean input
 *   long     a word of 10+ letters. Two distinct ones anywhere in the memory
 *            are needed: a lone "instructions" shares a word with most payloads
 *            and nothing else
 * A bullet carrying any part of a match is dropped whole, since a bullet
 * redacted in place still carries the wording around the hole.
 */
import type { ObservationRow, SummaryRow } from "../sources/claude-mem.ts";
import { citedIds, SECTIONS } from "./ledger.ts";

export const SECURITY_KINDS = [
  "instruction-in-data",
  "credential-exfil",
  "destructive-command",
  "remote-code",
  "policy-rewrite",
  "other",
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

export interface SecurityNote {
  obs: string;
  kind: SecurityKind;
}

const OBS_ID = /^obs:\d+$/;

/**
 * `security_notes` from a reply. A note is rejected, and counted without its
 * text, when it is not an object or its `obs` is not exactly one shown
 * observation id: a session id, a range, a wildcard or a list in one string is
 * rejected, never widened. An unknown kind becomes `other`. A missing field is
 * no notes, so an older reply parses. One entry per observation: repeated
 * notes merge their kinds.
 */
export function parseSecurityNotes(
  value: unknown,
  valid: ReadonlySet<string>,
): { notes: SecurityNote[]; rejected: number } {
  if (!Array.isArray(value)) return { notes: [], rejected: 0 };
  const byObs = new Map<string, Set<SecurityKind>>();
  let rejected = 0;
  for (const item of value) {
    const obs = typeof item === "object" && item !== null ? (item as { obs?: unknown }).obs : undefined;
    if (typeof obs !== "string" || !OBS_ID.test(obs) || !valid.has(obs)) {
      rejected += 1;
      continue;
    }
    const raw = (item as { kind?: unknown }).kind;
    const kind = SECURITY_KINDS.find((k) => k === raw) ?? "other";
    byObs.set(obs, (byObs.get(obs) ?? new Set()).add(kind));
  }
  const notes = [...byObs].flatMap(([obs, kinds]) => [...kinds].sort().map((kind) => ({ obs, kind })));
  return { notes, rejected };
}

/**
 * The one runtime-authored bullet for every quarantined observation. Built only
 * from the ids, their sessions and the kinds; null when nothing is quarantined.
 */
export function securityRecord(
  notes: readonly SecurityNote[],
  sessionOf: (obs: string) => string | null,
): string | null {
  const kinds = new Map<string, Set<SecurityKind>>();
  for (const n of notes) kinds.set(n.obs, (kinds.get(n.obs) ?? new Set()).add(n.kind));
  if (kinds.size === 0) return null;
  const ids = [...kinds.keys()].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  const parts = ids.map((obs) => {
    const session = sessionOf(obs);
    const ks = [...kinds.get(obs)!].sort().join(", ");
    return `${obs} (${session === null ? "" : `session ${session}; `}${ks})`;
  });
  const what = ids.length === 1 ? "an instruction" : "instructions";
  return `- Security: ${parts.join(", ")} carried ${what} aimed at the agent; recorded as untrusted data and not acted on. [${ids.join(", ")}]`;
}

/** `lines` with `record` appended at the end of `## Unresolved`. */
export function withSecurityRecord(lines: readonly string[], record: string | null): string[] {
  if (record === null) return [...lines];
  const start = lines.findIndex((line) => line.trimEnd() === SECTIONS[2]);
  if (start === -1) return [...lines];
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  while (end > start + 1 && lines[end - 1]!.trim() === "") end -= 1;
  return [...lines.slice(0, end), record, ...lines.slice(end)];
}

/**
 * Wording by which a model bullet describes an instruction aimed at the agent:
 * the backstop. Only phrases that name that attack are matched. Words that also
 * describe routine work (`injection`, `untrusted`, `malicious`, `ignored`,
 * `not acted on`) are left out, since a clean observation quarantined by an
 * ordinary bullet loses its facts and gains a false security record. A
 * describing bullet that also cites a clean observation quarantines it too;
 * that fails closed in the same way as a flagged observation's own facts.
 */
export const ATTACK_WORDING =
  /\b(?:prompt[- ]?injections?|(?:injected|embedded) (?:instructions?|prompts?)|instructions? (?:aimed|addressed|directed) at (?:the )?(?:agent|assistant|ai)|tried to (?:add|insert|plant|inject) (?:an? )?instructions?)\b/i;

const SEPARATORS = /[\s"'`<>()[\]{}|,;!*\\]+/;

/** Function words a phrase match skips, so a phrase is three content words. */
const STOPWORDS = new Set(
  "a an and are as at be been but by can do does for from had has have he her his i if in into is it its me my no not of on or our she so than that the their them then there these they this those to was we were what when which who will with would you your".split(
    " ",
  ),
);

/** A marked token: 6+ characters with a digit, dot, slash, dash or underscore. */
export function markedShape(token: string): boolean {
  return token.length >= 6 && /[0-9./_-]/.test(token);
}

/** Every marked token in `text`, lowercased: each whitespace-separated piece and its URL, host and path parts. */
export function candidateTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize("NFKC").toLowerCase().split(SEPARATORS)) {
    const token = raw.replace(/[.,:;?!]+$/, "");
    for (const piece of [token, ...token.split(/[/:?=&#@]+/), ...token.split(/[/:?=&#@.]+/)]) {
      if (markedShape(piece)) out.add(piece);
    }
  }
  return out;
}

/** Normalized words: compatibility forms folded, format characters and accents removed, lowercased, split on non-alphanumerics. */
export function normalWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

/** Credential formats and home directories, each replaced by `[redacted:<kind>]` before captured text is kept. */
const SECRETS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["api-key", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["bearer-token", /(?<=\bBearer\s+)(?=[A-Za-z0-9._~+/-]*[0-9])[A-Za-z0-9._~+/-]{20,}=*/gi],
  ["url-credentials", /(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@:"'<>]+:(?![$%{<])[^\s/?#@"'<>]+(?=@)/g],
  [
    "env-secret",
    /(?<=\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*["']?)[^\s"']{8,}/g,
  ],
  [
    "home-path",
    /(?<=^|[\s"'`([{<=,;:|>])(?:\/(?:var\/)?home\/[A-Za-z0-9._-]+|\/Users\/(?!Shared\b)[A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/gm,
  ],
];

/** `text` with every credential and home directory replaced by its kind. The one scrubber for text captured from a host record. */
export function scrubSecrets(text: string): string {
  return SECRETS.reduce((out, [kind, pattern]) => out.replace(pattern, `[redacted:${kind}]`), text);
}

function observationText(row: ObservationRow): string {
  return [row.title, row.subtitle, row.narrative, row.facts, row.concepts, row.files_read, row.files_modified]
    .filter((v) => v)
    .join("\n");
}

function summaryText(s: SummaryRow): string {
  return [s.request, s.completed, s.next_steps].filter((v) => v).join("\n");
}

/** A bullet's claim: the `- ` and every bracketed citation removed. */
function claim(line: string): string {
  return line.replace(/^\s*- /, "").replace(/\[[^\]]*\]/g, " ");
}

/** Where `seq` occurs in `stream` as consecutive items. */
function occurrences(stream: readonly string[], seq: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + seq.length <= stream.length; i++) if (seq.every((w, j) => stream[i + j] === w)) out.push(i);
  return out;
}

const joined = (seq: readonly string[]) => ` ${seq.join(" ")} `;

export interface Fragments {
  /** Marked tokens as word sequences. */
  marked: string[][];
  /** Three-word content phrases. */
  phrases: string[][];
  long: string[];
}

/** The fragments of `tainted` that no text in `clean` holds. */
export function distinctiveFragments(tainted: string, clean: string): Fragments {
  const cleanWords = normalWords(clean);
  const cleanVocab = new Set(cleanWords);
  const cleanStream = joined(cleanWords);
  const cleanRun = cleanWords.join("");
  const cleanContent = joined(cleanWords.filter((w) => !STOPWORDS.has(w)));
  const marked = new Map<string, string[]>();
  for (const token of candidateTokens(tainted)) {
    const seq = normalWords(token);
    const run = seq.join("");
    if (run.length < 4 || cleanStream.includes(joined(seq)) || (run.length >= 8 && cleanRun.includes(run))) continue;
    marked.set(seq.join(" "), seq);
  }
  const words = normalWords(tainted);
  const content = words.filter((w) => !STOPWORDS.has(w));
  const phrases = new Map<string, string[]>();
  for (let i = 0; i + 3 <= content.length; i++) {
    const seq = content.slice(i, i + 3);
    if (!cleanContent.includes(joined(seq)) && seq.some((w) => !cleanVocab.has(w))) phrases.set(seq.join(" "), seq);
  }
  const long = [...new Set(words.filter((w) => /^\p{L}{10,}$/u.test(w) && !cleanVocab.has(w)))];
  return { marked: [...marked.values()], phrases: [...phrases.values()], long };
}

/**
 * Indexes of the `claims` that carry a fragment, scanning them as one stream in
 * order, so a fragment split across two bullets marks both.
 */
export function carriers(claims: readonly string[], f: Fragments): Set<number> {
  const words: string[] = [];
  const owner: number[] = [];
  claims.forEach((text, i) => {
    for (const w of normalWords(text)) {
      words.push(w);
      owner.push(i);
    }
  });
  const content = words.flatMap((w, i) => (STOPWORDS.has(w) ? [] : [i]));
  const contentWords = content.map((i) => words[i]!);
  let run = "";
  const runOwner: number[] = [];
  words.forEach((w, i) => {
    run += w;
    for (let k = 0; k < w.length; k++) runOwner.push(owner[i]!);
  });
  const hit = new Set<number>();
  const mark = (from: number, to: number, own: readonly number[]) => {
    for (let k = from; k < to; k++) hit.add(own[k]!);
  };
  for (const seq of f.marked) {
    for (const i of occurrences(words, seq)) mark(i, i + seq.length, owner);
    const flat = seq.join("");
    if (flat.length >= 8)
      for (let at = run.indexOf(flat); at !== -1; at = run.indexOf(flat, at + 1)) mark(at, at + flat.length, runOwner);
  }
  const contentOwner = content.map((i) => owner[i]!);
  for (const seq of f.phrases) for (const i of occurrences(contentWords, seq)) mark(i, i + seq.length, contentOwner);
  const found = f.long.filter((w) => run.includes(w));
  if (found.length >= 2) {
    for (const w of found)
      for (let at = run.indexOf(w); at !== -1; at = run.indexOf(w, at + 1)) mark(at, at + w.length, runOwner);
  }
  return hit;
}

export interface RedactInputs {
  observations: readonly ObservationRow[];
  summaries: readonly SummaryRow[];
  previous: string;
  notes: readonly SecurityNote[];
}

export interface RedactResult {
  kept: string[];
  /** Bullets citing a quarantined observation. */
  flagged: number;
  /** Bullets carrying text only a quarantined observation holds. */
  tokens: number;
  /** The quarantine: the notes, plus each inferred id as kind `other`. */
  quarantine: SecurityNote[];
  /** Shown observation ids quarantined by the wording backstop and not by a note. */
  inferred: string[];
}

const isBullet = (line: string) => line.trimStart().startsWith("- ");

/**
 * Quarantine the noted observations and those a describing bullet cites, drop
 * every bullet citing one, then every bullet carrying text only a quarantined
 * observation holds. Headings and blank lines pass.
 */
export function redact(lines: readonly string[], inputs: RedactInputs): RedactResult {
  const shown = new Set(inputs.observations.map((row) => `obs:${row.id}`));
  const noted = new Set(inputs.notes.map((n) => n.obs));
  const inferred = new Set<string>();
  for (const line of lines) {
    if (!isBullet(line) || !ATTACK_WORDING.test(line.normalize("NFKC"))) continue;
    for (const id of citedIds(line)) if (shown.has(id) && !noted.has(id)) inferred.add(id);
  }
  const quarantined = new Set([...noted, ...inferred]);
  const isQuarantined = (row: ObservationRow) => quarantined.has(`obs:${row.id}`);
  const taintedSessions = new Set(inputs.observations.filter(isQuarantined).map((row) => row.memory_session_id));
  const isTainted = (s: SummaryRow) => taintedSessions.has(s.memory_session_id);
  const clean = [
    ...inputs.observations.filter((row) => !isQuarantined(row)).map(observationText),
    ...inputs.summaries.filter((s) => !isTainted(s)).map(summaryText),
    inputs.previous,
    ...SECTIONS,
  ].join("\n");
  const tainted = [
    ...inputs.observations.filter(isQuarantined).map(observationText),
    ...inputs.summaries.filter(isTainted).map(summaryText),
  ].join("\n");
  const survivors: number[] = [];
  let flagged = 0;
  lines.forEach((line, i) => {
    if (!isBullet(line)) return;
    if ([...citedIds(line)].some((id) => quarantined.has(id))) flagged += 1;
    else survivors.push(i);
  });
  const hit =
    tainted === ""
      ? new Set<number>()
      : carriers(
          survivors.map((i) => claim(lines[i]!)),
          distinctiveFragments(tainted, clean),
        );
  const drop = new Set([...hit].map((k) => survivors[k]!));
  const kept = lines.filter((line, i) => !isBullet(line) || (survivors.includes(i) && !drop.has(i)));
  const quarantine = [...inputs.notes, ...[...inferred].map((obs) => ({ obs, kind: "other" as const }))];
  return { kept, flagged, tokens: drop.size, quarantine, inferred: [...inferred].sort() };
}
