/**
 * Kimi Code prompt mode for text-only reviewer sessions. Reviewers receive the transcript in the
 * prompt and need no repository tools, bundle, or event parsing.
 *
 *   kimi --prompt PROMPT --output-format text [--model M] --agent-file AGENT --skills-dir EMPTY
 *
 * Kimi Code 2.1.1 refuses `--prompt` with `--plan` ("Cannot combine --prompt with --plan."), and
 * prompt mode otherwise runs with every action pre-approved. So the seat is held by an agent
 * definition instead: `run` writes one for the call whose `tools: []` disables all tools and whose
 * `subagents: []` leaves nothing to delegate to, and selects it with `--agent-file`. Kimi's
 * agent-file documentation states that `tools: []` disables all tools and that the list is
 * enforced again before execution. The file's body replaces the default system prompt.
 *
 * `run` also points `--skills-dir` at an empty directory, so no user or project skill loads. Both
 * live in one directory created for the call and removed afterwards. The operator's Kimi home and
 * login are left where they are. Kimi Code 2.1.1 has no turn-cap flag, so `maxTurns` is not
 * passed: prompt mode runs the one prompt and the caller's timeout bounds it. `command` is the
 * receipt argv and omits the two per-call paths.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsync } from "../session.ts";
import type { SessionEvent, SessionRequest, SubjectAdapter } from "./types.ts";

/** The per-call agent definition: no tools, no sub-agents, and a body that replaces the default prompt. */
export const KIMI_REVIEWER_AGENT = [
  "---",
  "name: text-reviewer",
  "description: Answers one prompt in text, with no tools and no sub-agents.",
  "tools: []",
  "subagents: []",
  "---",
  "",
  "You have no tools. Answer the prompt in text, in a single reply.",
  "",
].join("\n");

export const kimi: SubjectAdapter = {
  host: "kimi",
  env: [],
  injection: "prompt-prefix",
  requestIds: false,
  command(req: SessionRequest, model: string | undefined): string[] {
    const prompt = req.appendSystemPrompt === undefined ? req.prompt : `${req.appendSystemPrompt}\n\n${req.prompt}`;
    return ["kimi", "--prompt", prompt, "--output-format", "text", ...(model === undefined ? [] : ["--model", model])];
  },
  async run(req, model, options) {
    const dir = mkdtempSync(join(tmpdir(), "ak-kimi-"));
    try {
      const agent = join(dir, "text-reviewer.md");
      const skills = join(dir, "skills");
      writeFileSync(agent, KIMI_REVIEWER_AGENT);
      mkdirSync(skills);
      return await runAsync([...kimi.command(req, model), "--agent-file", agent, "--skills-dir", skills], options);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  parse(stdout: string) {
    const reply = stdout.trim();
    const events: SessionEvent[] = reply === "" ? [] : [{ kind: "message", text: reply }];
    return { events, reply };
  },
};
