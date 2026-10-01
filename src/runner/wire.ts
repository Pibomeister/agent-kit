import Ajv2020 from "ajv/dist/2020.js";

import type { CardInput, StandingGrant } from "./types.ts";

export interface RunnerArgs {
  run?: string;
  charter?: string;
  implementer?: string;
  revision?: string;
  id?: string;
  source?: string;
  kind?: string;
  card_id?: string;
  seat?: string;
  actor?: string;
  dispatch?: string;
  choice?: string;
  rationale?: string;
  evidence?: string;
  key?: string;
  payload?: string;
  effect?: string;
  target?: string;
  input_hash?: string;
  limit?: string;
  subject?: string;
  amount?: number;
  excluded_actors?: string[];
  input_dispatches?: string[];
  lineage?: string[];
  card?: CardInput;
  standing_grant?: StandingGrant;
}

export interface Request {
  token: string;
  verb: string;
  args: RunnerArgs;
}
export interface Response {
  ok: boolean;
  result?: object | string | number | boolean | null;
  error?: string;
}
export interface SeatLauncher {
  seat: string;
  actor: string;
  lineage: string[];
  command: string[];
}
export interface SeatConfig {
  launchers: SeatLauncher[];
}
export interface SeatAnswer {
  choice: string;
  rationale: string;
}
export interface VerifyConfig {
  command: string[];
}
export interface EffectAdapter {
  effect: string;
  read_back: string[];
  perform: string[];
}
export interface EffectConfig {
  adapters: EffectAdapter[];
}

const grant = {
  type: "object",
  required: ["charter_hash", "covers"],
  additionalProperties: false,
  properties: { charter_hash: { type: "string" }, covers: { type: "string" }, decision: { type: "string" } },
};
const stringArray = { type: "array", items: { type: "string" } };
const stringFields = [
  "run",
  "charter",
  "implementer",
  "revision",
  "id",
  "source",
  "kind",
  "card_id",
  "seat",
  "actor",
  "dispatch",
  "choice",
  "rationale",
  "evidence",
  "key",
  "payload",
  "effect",
  "target",
  "input_hash",
  "limit",
  "subject",
];
const argsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(stringFields.map((field) => [field, { type: "string" }])),
    amount: { type: "integer", minimum: 1 },
    excluded_actors: stringArray,
    input_dispatches: stringArray,
    lineage: stringArray,
    standing_grant: {
      type: "object",
      additionalProperties: false,
      required: ["charter_hash", "covers", "controller", "run_id"],
      properties: {
        charter_hash: { type: "string" },
        covers: { const: "autopilot.start" },
        controller: { const: "firstmate" },
        run_id: { type: "string" },
      },
    },
    card: {
      type: "object",
      additionalProperties: false,
      required: ["id", "operation", "grant", "question", "options", "evidence", "artifact_hash"],
      properties: {
        id: { type: "string" },
        operation: { type: "string" },
        grant,
        additional_grants: { type: "array", items: grant },
        emits_tickets: { type: "boolean" },
        question: { type: "string" },
        options: stringArray,
        evidence: stringArray,
        artifact_hash: { type: "string" },
        human_experience: { type: "boolean" },
      },
    },
  },
};
const ajv = new Ajv2020({ strict: false });
export const isArgs = ajv.compile<RunnerArgs>(argsSchema);
export const isRequest = ajv.compile<Request>({
  type: "object",
  additionalProperties: false,
  required: ["token", "verb", "args"],
  properties: { token: { type: "string" }, verb: { type: "string" }, args: argsSchema },
});
export const isResponse = ajv.compile<Response>({
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" }, result: true, error: { type: "string" } },
});
export const isSeatConfig = ajv.compile<SeatConfig>({
  type: "object",
  additionalProperties: false,
  required: ["launchers"],
  properties: {
    launchers: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seat", "actor", "lineage", "command"],
        properties: { seat: { type: "string" }, actor: { type: "string" }, lineage: stringArray, command: stringArray },
      },
    },
  },
});
export const isSeatAnswer = ajv.compile<SeatAnswer>({
  type: "object",
  additionalProperties: false,
  required: ["choice", "rationale"],
  properties: { choice: { type: "string" }, rationale: { type: "string" } },
});
export const isVerifyConfig = ajv.compile<VerifyConfig>({
  type: "object",
  additionalProperties: false,
  required: ["command"],
  properties: { command: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } },
});
export const isEffectConfig = ajv.compile<EffectConfig>({
  type: "object",
  additionalProperties: false,
  required: ["adapters"],
  properties: {
    adapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["effect", "read_back", "perform"],
        properties: {
          effect: { type: "string" },
          read_back: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          perform: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
});
