/**
 * The skill doctor's report: one self-contained HTML file.
 *
 * Adapted from the donor's `scripts/render_report.py` for its content (the
 * scorecard, the three findings, the suggested edits with their diffs) and
 * nothing else: no vendor mark, no call to action, no script bundle and no
 * remote font or stylesheet, so opening the report makes no network request.
 * Every value is escaped, and the caller writes the file through the secret gate.
 */
import type { Collection } from "./collect.ts";
import type { Aggregate, Scorer, SessionScore } from "./score.ts";
import { SCORERS, WEIGHTS } from "./score.ts";
import type { Advice } from "./suggest.ts";

/** A diff longer than this many lines starts collapsed. */
const OPEN_DIFF_LINES = 40;

const SCORE_TITLES: Readonly<Record<Scorer | "skill_coverage", string>> = {
  efficiency: "Efficiency",
  code_quality: "Code quality",
  procedure_compliance: "Procedure",
  verbosity: "Verbosity",
  skill_coverage: "Skill coverage",
};

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const e = escapeHtml;

function percent(value: number): string {
  return `${Math.round(value * 100)}`;
}

const STYLE = `
:root{--page:#FAF9F5;--surface:#F0EEE6;--border:#E8E6DC;--text:#141413;--muted:#5E5D59;--accent:#D97757;--accent-hover:#C6613F;
--good:#3F7A4F;--bad:#B5452F;--add:#E3EFDF;--del:#F6E1DA;--chip:#E8E6DC;
--serif:"Source Serif 4","Iowan Old Style","Palatino Linotype",Georgia,serif;--sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--page:#1F1E1D;--surface:#262624;--border:#3D3D3A;--text:#FAF9F5;--muted:#B7B5A9;
--good:#8CC59A;--bad:#E8907A;--add:#24382A;--del:#43281F;--chip:#3D3D3A}}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:960px;margin:0 auto;padding:48px 24px 64px}
h1,h2,h3{font-family:var(--serif);font-weight:600;line-height:1.25;margin:0}
h1{font-size:2.25rem}h2{font-size:1.5rem;margin-bottom:16px}h3{font-size:1.125rem}
section{margin-top:56px}
p{margin:0 0 16px;max-width:68ch}
.muted{color:var(--muted)}.small{font-size:.875rem}
a{color:var(--accent)}a:hover{color:var(--accent-hover)}
.lead{font-size:1.0625rem;max-width:68ch;margin-top:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px}
.scorecard{display:grid;grid-template-columns:minmax(200px,1fr) 2fr;gap:24px;align-items:stretch}
.grade{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:8px}
.grade .letter{font-family:var(--serif);font-size:4.5rem;line-height:1;color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px}
.tile{background:var(--page);border:1px solid var(--border);border-radius:8px;padding:16px}
.tile .value{font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums}
.meter{height:6px;background:var(--chip);border-radius:3px;margin-top:8px;overflow:hidden}
.meter span{display:block;height:100%;background:var(--accent)}
ol.findings{margin:0;padding-left:24px;max-width:68ch}ol.findings li{margin-bottom:12px}
.suggestion{margin-bottom:24px}
.suggestion header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
.chip{display:inline-block;font-size:.8125rem;padding:2px 8px;border-radius:999px;background:var(--chip);color:var(--text);white-space:nowrap}
.chip.bad{background:var(--del);color:var(--bad)}.chip.good{background:var(--add);color:var(--good)}
dl{margin:8px 0 16px;display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{color:var(--muted)}dd{margin:0;min-width:0;overflow-wrap:anywhere}
ul.evidence{margin:0;padding-left:20px}
details{margin-top:8px}summary{cursor:pointer;color:var(--accent);font-size:.9375rem}summary:hover{color:var(--accent-hover)}
summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
pre.diff{margin:8px 0 0;padding:16px;background:var(--page);border:1px solid var(--border);border-radius:8px;overflow-x:auto;font:13px/1.5 var(--mono)}
pre.diff span{display:block;white-space:pre}
.l-add{background:var(--add)}.l-del{background:var(--del)}.l-hunk{color:var(--muted)}
code{font-family:var(--mono);font-size:.875em;background:var(--chip);padding:1px 6px;border-radius:4px;overflow-wrap:anywhere}
.table{overflow-x:auto;border:1px solid var(--border);border-radius:12px}
table{border-collapse:collapse;width:100%;font-size:.9375rem}
th,td{text-align:left;padding:12px;border-bottom:1px solid var(--border);vertical-align:top}
th{font-weight:600;background:var(--surface);white-space:nowrap}tr:last-child td{border-bottom:0}
td.key{font-family:var(--mono);font-size:.8125rem;overflow-wrap:anywhere;min-width:150px}
td .chip{white-space:normal;border-radius:8px}
.reasons{margin:8px 0 0;padding-left:18px;color:var(--muted);font-size:.875rem;max-width:68ch}
footer{margin-top:64px;padding-top:24px;border-top:1px solid var(--border)}
@media (max-width:640px){main{padding:32px 16px 48px}.scorecard{grid-template-columns:1fr}h1{font-size:1.75rem}.grade .letter{font-size:3.5rem}}
`;

function diffBlock(diff: string): string {
  const lines = diff.trimEnd().split("\n");
  const body = lines
    .map((line) => {
      const kind = line.startsWith("@@")
        ? "l-hunk"
        : line.startsWith("+") && !line.startsWith("+++")
          ? "l-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "l-del"
            : "";
      return `<span${kind === "" ? "" : ` class="${kind}"`}>${e(line) || " "}</span>`;
    })
    .join("");
  const pre = `<pre class="diff" aria-label="Unified diff">${body}</pre>`;
  return `<details${lines.length <= OPEN_DIFF_LINES ? " open" : ""}><summary>Diff, ${lines.length} lines</summary>${pre}</details>`;
}

function scorecard(aggregate: Aggregate): string {
  const names: ReadonlyArray<Scorer | "skill_coverage"> = [...SCORERS, "skill_coverage"];
  const tiles = names
    .map((name) => {
      const value = aggregate.scores[name];
      return `<div class="tile"><div class="small muted">${e(SCORE_TITLES[name])} · weight ${WEIGHTS[name]}</div><div class="value">${percent(value)}</div><div class="meter" role="img" aria-label="${e(SCORE_TITLES[name])} ${percent(value)} of 100"><span style="width:${percent(value)}%"></span></div></div>`;
    })
    .join("");
  return `<div class="scorecard"><div class="card grade"><div class="small muted">Overall</div><div class="letter">${e(aggregate.grade)}</div><div class="value">${percent(aggregate.scores.overall)} / 100</div><div class="small muted">${aggregate.sessions_scored} scored · ${aggregate.failed.length} failed</div></div><div class="tiles">${tiles}</div></div>`;
}

function suggestions(advice: Advice): string {
  if (advice.status === "unavailable")
    return `<p>The suggestion step was unavailable: ${e(advice.why ?? "no reason given")}. No edit is proposed.</p>`;
  if (advice.suggestions.length === 0)
    return "<p>No edit cleared the bar. That is a valid result: an edit without a failed session behind it is worse than none.</p>";
  return advice.suggestions
    .map((s) => {
      const evidence = s.evidence
        .map((item) => `<li><code>${e(item.session)}</code> · ${e(item.scorer)}: ${e(item.moment)}</li>`)
        .join("");
      return `<article class="card suggestion"><header><h3>${e(s.skill)}</h3><span class="chip">${s.kind === "new" ? "new skill" : "edit"} · <code>${e(s.id)}</code></span></header><p>${e(s.change)}</p><dl><dt>Rule</dt><dd>${e(s.rule)}</dd>${s.path === undefined ? "" : `<dt>File</dt><dd><code>${e(s.path)}</code></dd>`}<dt>Decide</dt><dd><code>ak learn doctor accept ${e(s.id)}</code> or <code>ak learn doctor reject ${e(s.id)} --reason "…"</code></dd></dl><div class="small muted">Evidence</div><ul class="evidence">${evidence}</ul>${diffBlock(s.diff)}</article>`;
    })
    .join("");
}

function screened(advice: Advice): string {
  const rows = [
    ...advice.dropped.map(
      (d) => `<tr><td>${e(d.skill)}</td><td>${e(d.change)}</td><td>Dropped: ${e(d.gate)}</td></tr>`,
    ),
    ...advice.deferred.map((d) => `<tr><td>—</td><td>${e(d.finding)}</td><td>Deferred: ${e(d.why)}</td></tr>`),
  ];
  if (rows.length === 0) return "";
  return `<section><h2>Screened out</h2><p class="muted">Proposals a gate refused, and patterns the doctor saw but chose not to turn into an edit.</p><div class="table"><table><thead><tr><th scope="col">Skill</th><th scope="col">Proposal or pattern</th><th scope="col">Outcome</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></section>`;
}

function sessionRows(scores: readonly SessionScore[]): string {
  return scores
    .map((score) => {
      const labels = SCORERS.map((scorer) => {
        const result = score.results[scorer];
        if (result === undefined) return `<td><span class="chip">—</span></td>`;
        const tone = result.score === null ? "" : result.score < 0.5 ? " bad" : result.score >= 0.8 ? " good" : "";
        return `<td><span class="chip${tone}">${e(result.label.replaceAll("_", " "))}</span></td>`;
      }).join("");
      const reasons = SCORERS.flatMap((scorer) => {
        const result = score.results[scorer];
        return result === undefined || result.reason === ""
          ? []
          : [`<li><strong>${e(SCORE_TITLES[scorer])}:</strong> ${e(result.reason)}</li>`];
      }).join("");
      const status =
        score.status === "unavailable"
          ? `<span class="chip">unavailable</span><div class="small muted">${e(score.why ?? "")}</div>`
          : score.failed
            ? `<span class="chip bad">failed</span>`
            : `<span class="chip good">passed</span>`;
      const detail =
        reasons === "" ? "" : `<details><summary>Reasons</summary><ul class="reasons">${reasons}</ul></details>`;
      return `<tr><td class="key">${e(score.key)}${detail}</td><td>${e(score.skills_used.join(", ") || "none")}</td>${labels}<td>${score.corrections}</td><td>${status}</td></tr>`;
    })
    .join("");
}

export interface ReportInput {
  title: string;
  collection: Collection;
  scores: readonly SessionScore[];
  aggregate: Aggregate;
  advice: Advice;
}

/** The whole report. Pure: the same input renders the same bytes. */
export function renderReport(input: ReportInput): string {
  const { collection, aggregate, advice } = input;
  const used = new Set(input.scores.flatMap((score) => score.skills_used));
  const findings =
    advice.findings.length === 0
      ? "<p>No finding was returned.</p>"
      : `<ol class="findings">${advice.findings.map((f) => `<li>${e(f)}</li>`).join("")}</ol>`;
  const tldr =
    aggregate.sessions_scored === 0
      ? "No sampled session could be scored, so there is no grade. Raise the window or check the judge command."
      : `${aggregate.sessions_scored} recent sessions were scored against four rubrics. The overall grade is ${aggregate.grade} (${percent(aggregate.scores.overall)} of 100). ${aggregate.failed.length} session(s) failed at least one rubric, and ${advice.suggestions.length} skill edit(s) passed every gate. ${advice.suggestions.length === 0 ? "No decision is required." : "No decision is required to read this report; each edit below names the command that accepts or rejects it."}`;
  const notes = [
    ...aggregate.notes,
    `Scores are curved as 0.5 + 0.5 × the rubric mean. A session fails when any applicable rubric scores below 0.5.`,
    `Skill coverage is the share of scored sessions that used an installed skill.`,
    `Transcripts were read on this machine and are not part of this report. User corrections are counted by the claude-reflect detector; claude-mem summaries were read when present.`,
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${e(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>${e(input.title)}</h1>
<p class="small muted">Generated ${e(collection.generated_at)} · last ${collection.window_days} days · hosts: ${e(collection.hosts.join(", "))} · ${collection.sessions_scanned} sessions scanned, ${collection.sessions_matched} matched, ${collection.sampled.length} sampled · ${collection.skills.length} skills found, ${used.size} used</p>
<p class="lead">${e(tldr)}</p>
</header>
<section aria-labelledby="scores"><h2 id="scores">Scorecard</h2>${scorecard(aggregate)}</section>
<section aria-labelledby="findings"><h2 id="findings">Top findings</h2>${findings}</section>
<section aria-labelledby="edits"><h2 id="edits">Suggested skill edits</h2>${suggestions(advice)}</section>
${screened(advice)}
<section aria-labelledby="sessions"><h2 id="sessions">Sessions</h2><div class="table"><table><thead><tr><th scope="col">Session</th><th scope="col">Skills</th><th scope="col">Efficiency</th><th scope="col">Code quality</th><th scope="col">Procedure</th><th scope="col">Verbosity</th><th scope="col">Corrections</th><th scope="col">Result</th></tr></thead><tbody>${sessionRows(input.scores)}</tbody></table></div></section>
<footer><h2>Method</h2><ul class="small muted">${notes.map((n) => `<li>${e(n)}</li>`).join("")}</ul></footer>
</main>
</body>
</html>
`;
}
