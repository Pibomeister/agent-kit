import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..");

interface PriorityPolicy {
  checkpoints: {
    on_block: {
      prioritized_work: {
        applies_when: string;
        self_servable_stop: string;
        answer_sources: string[];
        on_answer_found: string;
        true_blocker: {
          deadline_seconds: number;
          clock_starts: string;
          exact_text_from: string;
          display_text: string;
          status_surface: string;
        };
        outer_loop: string;
        ruling: string;
      };
    };
  };
}

const isPriorityPolicy = new Ajv({ strict: false }).compile<PriorityPolicy>({
  type: "object",
  required: ["checkpoints"],
  properties: {
    checkpoints: {
      type: "object",
      required: ["on_block"],
      properties: {
        on_block: {
          type: "object",
          required: ["prioritized_work"],
          properties: {
            prioritized_work: {
              type: "object",
              required: [
                "applies_when",
                "self_servable_stop",
                "answer_sources",
                "on_answer_found",
                "true_blocker",
                "outer_loop",
                "ruling",
              ],
              properties: {
                applies_when: { type: "string" },
                self_servable_stop: { type: "string" },
                answer_sources: { type: "array", items: { type: "string" } },
                on_answer_found: { type: "string" },
                true_blocker: {
                  type: "object",
                  required: ["deadline_seconds", "clock_starts", "exact_text_from", "display_text", "status_surface"],
                  properties: {
                    deadline_seconds: { type: "number" },
                    clock_starts: { type: "string" },
                    exact_text_from: { type: "string" },
                    display_text: { type: "string" },
                    status_surface: { type: "string" },
                  },
                },
                outer_loop: { type: "string" },
                ruling: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
});

const PARSED_POLICY: unknown = parseYaml(readFileSync(join(ROOT, "policies/authority-defaults.yaml"), "utf8"));
if (!isPriorityPolicy(PARSED_POLICY)) {
  throw new TypeError(
    `authority defaults do not match the priority policy schema: ${JSON.stringify(isPriorityPolicy.errors)}`,
  );
}
const PRIORITIZED_WORK = PARSED_POLICY.checkpoints.on_block.prioritized_work;
const TRUE_BLOCKER = PRIORITIZED_WORK.true_blocker;

describe("prioritized work stop gate", () => {
  test("refuses to park a prioritized item on a self-servable question", () => {
    expect(PRIORITIZED_WORK).toMatchObject({
      applies_when: "the order or runner marks the blocked item P0 or otherwise prioritized",
      self_servable_stop: "refused",
      answer_sources: [
        "the order and its work source",
        "the repository and code in scope",
        "evidence already in hand and authorized to read",
      ],
      on_answer_found: "record the answer with its evidence and continue the prioritized item",
    });
  });

  test("puts a genuine blocker's exact text on the outer status surface within ten minutes", () => {
    expect(TRUE_BLOCKER).toEqual({
      deadline_seconds: 600,
      clock_starts: "when none of the authorized answer sources can resolve the question",
      exact_text_from: "schemas/common.schema.json#/$defs/escalation `need`",
      display_text: "{need}",
      status_surface: "return that text to the runner for verbatim display to the outer supervisor",
    });
    const blocker = "missing deploy credential scope for the named environment";
    expect(TRUE_BLOCKER.display_text.replace("{need}", blocker)).toBe(blocker);
    expect(PRIORITIZED_WORK.outer_loop).toBe(
      "Return control promptly so the outer supervisor can keep other lanes running. This policy starts no dispatcher or watcher and writes no supervisor state.",
    );
    expect(PRIORITIZED_WORK.ruling).toBe("firstmate-outer-loop-agent-kit-inner");
  });
});
