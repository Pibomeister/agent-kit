export const SCHEMA_REL = "research/held-out/evidence.schema.json";
export const TEMPLATE_REL = "research/held-out/evidence.template.json";
export const HUMAN_STEPS_REL = "research/held-out/HUMAN-STEPS.md";

export const DOCUMENTS = 24;
export const DEFECTS = 12;
export const CONTROLS = 12;
export const REPS = 3;
export const RUNS_PER_HOST = 144;
export const ADJUDICATORS = 2;

export type GateVerdict = "not-run" | "passed" | "failed";

export interface T4Corpus {
  documents: typeof DOCUMENTS;
  defects: typeof DEFECTS;
  controls: typeof CONTROLS;
  reps: typeof REPS;
  runs_per_host: typeof RUNS_PER_HOST;
  keys_holder: "curator";
  location: string | null;
}

export interface T4Adjudication {
  adjudicators: typeof ADJUDICATORS;
  tie_breaker: "domain-owner";
  blind: true;
  records: unknown[];
}

export interface T4Evidence {
  procedure: "T4-HELD-OUT";
  gate: "G3";
  suite: "T4";
  verdict: GateVerdict;
  reason: string;
  human_steps: string;
  commands?: { evidence: string };
  corpus: T4Corpus;
  adjudication: T4Adjudication;
  metrics: { material_recall: number | null };
  scores: object | null;
  hosts?: string[];
  who_fills: {
    curator: string;
    adjudicators: string;
    harness: string;
  };
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}
