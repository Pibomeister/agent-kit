/**
 * Shared types for the review-isolation probe (PRD R3.1–R3.4).
 *
 * Verdicts are measurements of one host version, not attestations for later
 * runs, and they never rest on the child's answer text.
 */

export const HOSTS = ["claude-code", "codex", "mastracode"] as const;
export type ProbeHost = (typeof HOSTS)[number];

export const ARM_IDS = [
  "parent-turn",
  "hooks-and-memory",
  "auto-loaded-instructions",
  "transcript-on-disk",
  "role-file-denied",
] as const;
export type ArmId = (typeof ARM_IDS)[number];

export const VERDICTS = ["pass", "fail", "recorded", "unobservable"] as const;
export type ArmVerdictKind = (typeof VERDICTS)[number];

export function isProbeHost(value: string): value is ProbeHost {
  for (const host of HOSTS) if (host === value) return true;
  return false;
}

export function isArmId(value: string): value is ArmId {
  for (const arm of ARM_IDS) if (arm === value) return true;
  return false;
}

/** A Read/cat (or equivalent) of one path, taken from the child's transcript. */
export interface ToolTouch {
  path: string;
  denied: boolean;
  succeeded: boolean;
}

/**
 * What the child's transcript and launch configuration actually expose.
 * `partitioned` is true only when every transcript line parsed as JSON, so
 * assistant text was separable from context.
 */
export interface ArmEvidence {
  transcriptPresent: boolean;
  launchPresent: boolean;
  partitioned: boolean;
  contextText: string;
  answerText: string;
  wholeText: string;
  loadedFiles: string[];
  toolTouches: ToolTouch[];
  /** True/false when the launch config names a fresh spawn; null when it does not say. */
  freshSubagent: boolean | null;
  childPrompt: string | null;
}

export interface ArmResult {
  id: ArmId;
  marker: string | null;
  verdict: ArmVerdictKind;
  reason: string;
  loadedFiles: string[];
  childTranscript: string | null;
  launchConfig: string | null;
}

export interface ProbeReport {
  host: ProbeHost;
  hostVersion: string;
  pluginsAndHooks: string;
  date: string;
  driver: "live" | "fixture";
  commands: string[];
  work: string;
  verdictPath: string;
  notePath: string;
  arms: ArmResult[];
}

export interface ProbeIo {
  out: (text: string) => void;
  err: (text: string) => void;
}
