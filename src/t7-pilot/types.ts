export const SCHEMA_REL = "research/t7-pilot/evidence.schema.json";
export const TEMPLATE_REL = "research/t7-pilot/evidence.template.json";
export const HUMAN_STEPS_REL = "research/t7-pilot/HUMAN-STEPS.md";

export const CHANGES_REQUIRED = 20;
export const REPOS_REQUIRED = 2;

export type GateVerdict = "not-run" | "passed" | "failed";

export interface HumanMeasure {
  value: number;
  recorder: "human";
}

export interface T7Pilot {
  changes_required: typeof CHANGES_REQUIRED;
  repos_required: typeof REPOS_REQUIRED;
  repos: string[];
  matched_baseline: string | null;
  changes: unknown[];
}

export interface T7Evidence {
  procedure: "T7-PILOT";
  gate: "G5";
  suite: "T7";
  verdict: GateVerdict;
  reason: string;
  human_steps: string;
  commands?: { evidence: string };
  pilot: T7Pilot;
  measures: {
    rework: HumanMeasure | null;
    cost: HumanMeasure | null;
    attention: HumanMeasure | null;
  };
  who_fills: {
    maintainer: string;
    humans: string;
    harness: string;
  };
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}
