/**
 * TP-ISO contaminated-adapter check (AT-27 / GAP-18).
 *
 * A review-seat launch is a fail when any parent canary (conversation, memory,
 * or auto-loaded instructions) appears in the seat's prompt, memory, or
 * instruction text. The child's answer is not an input. A flag on the adapter
 * is not an input. Missing native traces are T3, not this check.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

export const LEAK_CHANNELS = ["parent-context", "memory", "instructions"] as const;
export type LeakChannel = (typeof LEAK_CHANNELS)[number];

export interface AdapterParent {
  readonly context: string;
  readonly memory: string;
  readonly instructions: string;
}

export interface AdapterReviewSeat {
  readonly prompt: string;
  readonly memory: readonly string[];
  readonly instructions: readonly string[];
}

export interface AdapterReviewLaunch {
  readonly adapter: string;
  readonly parent: AdapterParent;
  readonly reviewSeat: AdapterReviewSeat;
}

export type IsolationVerdict =
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly leaks: readonly LeakChannel[] };

const ajv = new Ajv2020({ strict: false });

const isLaunch: ValidateFunction<AdapterReviewLaunch> = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["adapter", "parent", "reviewSeat"],
  properties: {
    adapter: { type: "string", minLength: 1 },
    parent: {
      type: "object",
      additionalProperties: false,
      required: ["context", "memory", "instructions"],
      properties: {
        context: { type: "string", minLength: 1 },
        memory: { type: "string", minLength: 1 },
        instructions: { type: "string", minLength: 1 },
      },
    },
    reviewSeat: {
      type: "object",
      additionalProperties: false,
      required: ["prompt", "memory", "instructions"],
      properties: {
        prompt: { type: "string" },
        memory: { type: "array", items: { type: "string" } },
        instructions: { type: "array", items: { type: "string" } },
      },
    },
  },
});

function markerFor(launch: AdapterReviewLaunch, channel: LeakChannel): string {
  if (channel === "parent-context") return launch.parent.context;
  if (channel === "memory") return launch.parent.memory;
  return launch.parent.instructions;
}

export function parseAdapterLaunch(text: string): AdapterReviewLaunch | null {
  try {
    // SAFETY: JSON.parse is any; isLaunch is the contract before use.
    const value = JSON.parse(text) as unknown;
    return isLaunch(value) ? value : null;
  } catch {
    return null;
  }
}

export function checkAdapterLaunch(launch: AdapterReviewLaunch): IsolationVerdict {
  const seatText = [launch.reviewSeat.prompt, ...launch.reviewSeat.memory, ...launch.reviewSeat.instructions];
  const leaks: LeakChannel[] = [];
  for (const channel of LEAK_CHANNELS) {
    const marker = markerFor(launch, channel);
    let leaked = false;
    for (const text of seatText) {
      if (text.includes(marker)) {
        leaked = true;
        break;
      }
    }
    if (leaked) leaks.push(channel);
  }
  if (leaks.length === 0) return { kind: "pass" };
  return { kind: "fail", leaks };
}
