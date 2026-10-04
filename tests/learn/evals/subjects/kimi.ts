/**
 * Kimi Code prompt mode for text-only reviewer sessions. Reviewers receive the transcript in the
 * prompt and need no repository tools, bundle, or event parsing.
 *
 *   kimi --prompt PROMPT --output-format text --plan --skills-dir EMPTY [--model M]
 *
 * `--plan` starts the session read-only, and `run` points `--skills-dir` at an empty directory it
 * creates for the call and removes afterwards, so no user or project skill loads. The operator's
 * Kimi home and login are left where they are. Kimi Code 2.1.1 has no turn-cap flag, so
 * `maxTurns` is not passed: prompt mode runs the one prompt and the caller's timeout bounds it.
 * `command` is the receipt argv and omits the per-call directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsync } from "../session.ts";
import type { SessionEvent, SessionRequest, SubjectAdapter } from "./types.ts";

export const kimi: SubjectAdapter = {
  host: "kimi",
  env: [],
  injection: "prompt-prefix",
  requestIds: false,
  command(req: SessionRequest, model: string | undefined): string[] {
    const prompt = req.appendSystemPrompt === undefined ? req.prompt : `${req.appendSystemPrompt}\n\n${req.prompt}`;
    return [
      "kimi",
      "--prompt",
      prompt,
      "--output-format",
      "text",
      "--plan",
      ...(model === undefined ? [] : ["--model", model]),
    ];
  },
  async run(req, model, options) {
    const skills = mkdtempSync(join(tmpdir(), "ak-kimi-skills-"));
    try {
      return await runAsync([...kimi.command(req, model), "--skills-dir", skills], options);
    } finally {
      rmSync(skills, { recursive: true, force: true });
    }
  },
  parse(stdout: string) {
    const reply = stdout.trim();
    const events: SessionEvent[] = reply === "" ? [] : [{ kind: "message", text: reply }];
    return { events, reply };
  },
};
