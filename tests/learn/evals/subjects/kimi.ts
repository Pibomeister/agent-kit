/**
 * Kimi Code prompt mode for text-only reviewer sessions. Reviewers receive the transcript in the
 * prompt and need no repository tools, bundle, or event parsing.
 *
 *   kimi --prompt PROMPT --output-format text [--model M]
 */
import type { SessionEvent, SessionRequest, SubjectAdapter } from "./types.ts";

export const kimi: SubjectAdapter = {
  host: "kimi",
  env: [],
  injection: "prompt-prefix",
  requestIds: false,
  command(req: SessionRequest, model: string | undefined): string[] {
    const prompt = req.appendSystemPrompt === undefined ? req.prompt : `${req.appendSystemPrompt}\n\n${req.prompt}`;
    return ["kimi", "--prompt", prompt, "--output-format", "text", ...(model === undefined ? [] : ["--model", model])];
  },
  parse(stdout: string) {
    const reply = stdout.trim();
    const events: SessionEvent[] = reply === "" ? [] : [{ kind: "message", text: reply }];
    return { events, reply };
  },
};
