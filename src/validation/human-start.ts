import { join } from "node:path";

import { entryBodyPath } from "../catalog/layout.ts";
import { readTextIfPresent } from "../util/fs.ts";
import { parseFrontmatter } from "../util/frontmatter.ts";
import { splitSections } from "./bodies.ts";
import type { CheckContext } from "./context.ts";
import { error, type Issue } from "./types.ts";

/**
 * What a user-invoked skill's own text has to say for "only a human starts it"
 * to be held at all.
 *
 * No host flag keeps the model from loading a U skill
 * (docs/decisions/0003-model-invocation.md), so the law rests on two pieces of
 * prose: the description a host reads before it loads the body, and the first
 * step a session reads after. `checkInvocation` judges who may call whom and
 * never reads either one, so a U skill whose description is only a topic, and
 * whose workflow opens on the work, passed every check while carrying nothing
 * that tells a session a prose request is not a start.
 *
 * Three properties, each a presence test on the text:
 *
 *   - the description names the typed command;
 *   - the description states the class, in the words `human-started`;
 *   - the first numbered item under `## Workflow` names the typed command and
 *     says to stop.
 *
 * What this does NOT check: that the wording works. A step can name the command
 * and say "stop" and still be read past; whether a session obeys it is what the
 * skill's non-trigger eval case observes, and nothing here stands in for that.
 * It also does not check that the step lets a validated grant through, which
 * depends on the entrypoints the skill declares.
 *
 * A missing body, a missing description and a missing `## Workflow` section are
 * other checks' reports (`completeness`, `frontmatter`, `body-shapes`). This one
 * is silent on them rather than putting one absence on two lines.
 */

const WORKFLOW_HEADING = "## Workflow";

/** The class, as the description states it. */
const CLASS_STATEMENT = /\bhuman-started\b/i;

const STOP_WORD = /\bstop\b/i;

const NUMBERED_ITEM = /^\d+\.\s/;

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` names `command` itself rather than a longer command that
 * starts with it: `/ak:compound-refresh` does not name `/ak:compound`.
 */
export function namesCommand(text: string, command: string): boolean {
  return new RegExp(`${escapeForPattern(command)}(?![a-z0-9]|-[a-z0-9])`, "i").test(text);
}

export interface FirstStep {
  readonly text: string;
  /** 1-based line within the text handed in. */
  readonly line: number;
}

/**
 * The first numbered item in a section, with its continuation lines.
 *
 * The item ends at the next numbered item or at the first unindented line,
 * whichever comes first, so a paragraph that follows step 1 is not read as part
 * of it.
 */
export function firstNumberedItem(sectionText: string): FirstStep | null {
  const lines = sectionText.split("\n");
  const start = lines.findIndex((line) => NUMBERED_ITEM.test(line));
  if (start === -1) return null;

  const collected = [lines[start] ?? ""];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    collected.push(line);
  }
  return { text: collected.join("\n"), line: start + 1 };
}

export function checkHumanStart(ctx: CheckContext): Issue[] {
  const { root, catalog } = ctx;
  const issues: Issue[] = [];
  const namespace = catalog.package.namespace === "" ? "/ak:" : catalog.package.namespace;

  for (const entry of catalog.bySection("skills")) {
    if (entry.invocation !== "U") continue;

    const file = entryBodyPath("skills", entry.id);
    const text = readTextIfPresent(join(root, file));
    if (text === null) continue;

    const parsed = parseFrontmatter(text);
    const command = `${namespace}${entry.id}`;

    const description = parsed.data["description"];
    if (typeof description === "string" && description.length > 0) {
      const line = parsed.keyLines["description"];
      if (!namesCommand(description, command)) {
        issues.push(
          error(
            "invocation.description-omits-command",
            file,
            `User-invoked skill '${entry.id}' does not name \`${command}\` in its description. A host reads the description before it loads the body and no host flag stops the model loading a user-invoked skill (docs/decisions/0003-model-invocation.md), so the description is where a session learns which command a human types. Name \`${command}\` in it.`,
            line,
          ),
        );
      }
      if (!CLASS_STATEMENT.test(description)) {
        issues.push(
          error(
            "invocation.description-omits-class",
            file,
            `User-invoked skill '${entry.id}' does not state its class in its description: the words 'human-started' are absent. A description that gives only the topic reads as an invitation to run the skill on any request about that topic. Say that the command is human-started and that any other request is answered by telling the human to type \`${command}\`.`,
            line,
          ),
        );
      }
      if (
        entry.id === "autopilot" &&
        (!/Firstmate-started/.test(description) || !/runner-validated standing\s+grant/i.test(description))
      ) {
        issues.push(
          error(
            "invocation.autopilot-description-omits-standing-start",
            file,
            "Autopilot's description must name Firstmate's runner-validated standing grant; prose naming the skill alone is not a start (ADR-0007).",
            line,
          ),
        );
      }
    }

    const workflow = splitSections(parsed.body).find((section) => section.heading === WORKFLOW_HEADING);
    if (workflow === undefined) continue;

    // `splitSections` numbers lines within the body; the section's text starts on the line after its heading.
    const headingLine = workflow.line + parsed.bodyStartLine - 1;
    const step = firstNumberedItem(workflow.text);
    if (step === null) {
      issues.push(
        error(
          "invocation.first-step-not-stop",
          file,
          `User-invoked skill '${entry.id}' has no numbered step under ${WORKFLOW_HEADING}, so it has no first step to hold the authority check. The first step names \`${command}\` and stops when the run was started by neither that command nor a validated grant (ruling \`entrypoint-phase-operation-split\`).`,
          headingLine,
        ),
      );
      continue;
    }

    const missing: string[] = [];
    if (!namesCommand(step.text, command)) missing.push(`name \`${command}\``);
    if (!STOP_WORD.test(step.text)) missing.push("say to stop");
    if (missing.length > 0) {
      issues.push(
        error(
          "invocation.first-step-not-stop",
          file,
          `The first step under ${WORKFLOW_HEADING} in user-invoked skill '${entry.id}' does not ${missing.join(" or ")}. A session that loads the body on a prose request reads this step first, and a first step that opens on the work starts the work. Make it the authority check: it names \`${command}\` and stops when the run was started by neither that command nor a validated grant (ruling \`entrypoint-phase-operation-split\`).`,
          headingLine + step.line,
        ),
      );
    }
    if (
      entry.id === "autopilot" &&
      (!/Firstmate/.test(step.text) || !/start_authority\.kind/.test(step.text) || !/standing-grant/.test(step.text))
    ) {
      issues.push(
        error(
          "invocation.autopilot-first-step-omits-standing-check",
          file,
          "Autopilot's first step must read the runner's standing-grant start attestation before phase work (ADR-0007).",
          headingLine + step.line,
        ),
      );
    }
  }

  return issues;
}
