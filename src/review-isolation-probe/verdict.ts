/**
 * Per-arm verdict from child transcript + launch configuration.
 *
 * The child's answer is never the deciding evidence. A passing leak arm means
 * that channel did not appear in the child's context at this host version. It
 * does not mean no other channel leaks.
 */
import type { ArmEvidence, ArmId, ArmVerdictKind } from "./types.ts";

export interface Verdict {
  kind: ArmVerdictKind;
  reason: string;
}

function containsMarker(text: string, marker: string): boolean {
  return marker !== "" && text.includes(marker);
}

function touchOf(evidence: ArmEvidence, path: string): { denied: boolean; succeeded: boolean } | null {
  let found: { denied: boolean; succeeded: boolean } | null = null;
  for (const touch of evidence.toolTouches) {
    if (touch.path === path || touch.path.endsWith(path) || path.endsWith(touch.path)) found = touch;
  }
  return found;
}

function leakVerdict(marker: string, evidence: ArmEvidence, channel: string): Verdict {
  if (!evidence.transcriptPresent && !evidence.launchPresent) {
    return { kind: "unobservable", reason: `${channel}: no child transcript or launch configuration was retained` };
  }
  if (evidence.freshSubagent === false) {
    return { kind: "fail", reason: `${channel}: launch configuration is a resume or fork, not a fresh subagent` };
  }
  const inContext = containsMarker(evidence.contextText, marker);
  const inChildPrompt = evidence.childPrompt !== null && containsMarker(evidence.childPrompt, marker);
  if (inContext || inChildPrompt) {
    return { kind: "fail", reason: `${channel}: marker present in the child context or child launch` };
  }
  if (!evidence.partitioned && containsMarker(evidence.wholeText, marker)) {
    return {
      kind: "unobservable",
      reason: `${channel}: marker is in an unparsed transcript; it cannot be attributed to context rather than the answer`,
    };
  }
  if (!evidence.transcriptPresent) {
    return {
      kind: "unobservable",
      reason: `${channel}: launch did not show a leak; no child transcript to confirm absence from the child trace`,
    };
  }
  if (containsMarker(evidence.answerText, marker)) {
    return {
      kind: "pass",
      reason: `${channel}: marker absent from child context and launch; the answer mentioned it and was ignored`,
    };
  }
  return { kind: "pass", reason: `${channel}: marker absent from the child context and launch configuration` };
}

function instructionsVerdict(evidence: ArmEvidence): Verdict {
  if (!evidence.transcriptPresent && !evidence.launchPresent) {
    return {
      kind: "unobservable",
      reason: "auto-loaded instructions: host did not expose a child transcript or launch configuration",
    };
  }
  if (!evidence.partitioned && evidence.loadedFiles.length === 0) {
    return {
      kind: "unobservable",
      reason: "auto-loaded instructions: instruction files cannot be read from this host's retained events",
    };
  }
  const files = evidence.loadedFiles.length === 0 ? "none observed" : evidence.loadedFiles.join(", ");
  return { kind: "recorded", reason: `auto-loaded instructions arrived as: ${files}` };
}

function deniedReadVerdict(evidence: ArmEvidence, path: string, channel: string, passWhenDenied: boolean): Verdict {
  if (!evidence.transcriptPresent) {
    return { kind: "unobservable", reason: `${channel}: no child transcript, so the read cannot be observed` };
  }
  if (!evidence.partitioned && evidence.toolTouches.length === 0) {
    return { kind: "unobservable", reason: `${channel}: this host's transcript does not expose tool results` };
  }
  const touch = touchOf(evidence, path);
  if (touch === null) {
    return { kind: "unobservable", reason: `${channel}: no tool call against ${path} in the child transcript` };
  }
  if (touch.denied) {
    return {
      kind: passWhenDenied ? "pass" : "fail",
      reason: `${channel}: child read of ${path} was denied`,
    };
  }
  if (touch.succeeded) {
    return {
      kind: passWhenDenied ? "fail" : "pass",
      reason: `${channel}: child read of ${path} succeeded`,
    };
  }
  return {
    kind: "unobservable",
    reason: `${channel}: a tool call named ${path} but neither denial nor success was recorded`,
  };
}

export function decideArm(
  arm: ArmId,
  marker: string | null,
  evidence: ArmEvidence,
  rolePath: string,
  transcriptPath: string,
): Verdict {
  switch (arm) {
    case "parent-turn":
      return leakVerdict(marker ?? "", evidence, "parent turn");
    case "hooks-and-memory":
      return leakVerdict(marker ?? "", evidence, "hooks and memory");
    case "auto-loaded-instructions":
      return instructionsVerdict(evidence);
    case "transcript-on-disk":
      return deniedReadVerdict(evidence, transcriptPath, "transcript on disk", true);
    case "role-file-denied":
      return deniedReadVerdict(evidence, rolePath, "role file denied", true);
  }
  return { kind: "unobservable", reason: "unrecognized arm" };
}
