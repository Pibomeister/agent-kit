/**
 * Per-arm verdict from child transcript + launch configuration.
 *
 * A passing leak arm means that channel did not appear in the child's context
 * at this host version, and that the host spawn was observed to be fresh. The
 * child's answer is never sufficient. Role-file-denied also requires the
 * answer to be exactly RESOURCE_UNREADABLE after a denied read.
 */
import { isAbsolute, resolve } from "node:path";

import type { UnplantableHalf } from "./plant.ts";
import type { ArmEvidence, ArmId, ArmVerdictKind } from "./types.ts";

export interface Verdict {
  kind: ArmVerdictKind;
  reason: string;
}

export interface DecidePaths {
  rolePath: string;
  transcriptPath: string;
  workspace: string;
}

export interface DecidePlant {
  plantedHalves: string[];
  unplantable: UnplantableHalf[];
}

function containsMarker(text: string, marker: string): boolean {
  return marker !== "" && text.includes(marker);
}

function resolveAgainst(workspace: string, path: string): string {
  if (path === "") return path;
  return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
}

function touchOf(
  evidence: ArmEvidence,
  path: string,
  workspace: string,
): { denied: boolean; succeeded: boolean } | null {
  if (path === "") return null;
  const wanted = resolveAgainst(workspace, path);
  for (const touch of evidence.toolTouches) {
    if (touch.path === "") continue;
    if (resolveAgainst(workspace, touch.path) === wanted) return touch;
  }
  return null;
}

function lastAnswerLine(evidence: ArmEvidence): string {
  const bits = evidence.answerText.split("\n").map((line) => line.trim());
  for (let i = bits.length - 1; i >= 0; i -= 1) {
    const line = bits[i];
    if (line !== undefined && line !== "") return line;
  }
  return "";
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
  if (evidence.freshSubagent === null) {
    return {
      kind: "unobservable",
      reason: `${channel}: host spawn arguments were not observed, so freshness cannot be confirmed`,
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

function withUnplantable(verdict: Verdict, plant: DecidePlant, channel: string): Verdict {
  if (plant.unplantable.length === 0 || verdict.kind === "fail") return verdict;
  const halves = plant.unplantable.map((row) => `${row.half} (${row.reason})`).join("; ");
  return {
    kind: "unobservable",
    reason: `${channel}: ${verdict.kind} on planted halves; unplantable: ${halves}`,
  };
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

function deniedReadVerdict(
  evidence: ArmEvidence,
  path: string,
  workspace: string,
  channel: string,
  passWhenDenied: boolean,
  requireExactUnread: boolean,
): Verdict {
  if (!evidence.transcriptPresent) {
    return { kind: "unobservable", reason: `${channel}: no child transcript, so the read cannot be observed` };
  }
  if (!evidence.partitioned && evidence.toolTouches.length === 0) {
    return { kind: "unobservable", reason: `${channel}: this host's transcript does not expose tool results` };
  }
  const touch = touchOf(evidence, path, workspace);
  if (touch === null) {
    return { kind: "unobservable", reason: `${channel}: no tool call against ${path} in the child transcript` };
  }
  if (touch.denied) {
    if (requireExactUnread && lastAnswerLine(evidence) !== "RESOURCE_UNREADABLE") {
      return {
        kind: "fail",
        reason: `${channel}: child read of ${path} was denied, but the answer was not exactly RESOURCE_UNREADABLE`,
      };
    }
    let fired = "";
    if (evidence.preToolUseFired === true) fired = "; PreToolUse fired for the subagent call";
    else if (evidence.preToolUseFired === false) fired = "; PreToolUse did not fire";
    return {
      kind: passWhenDenied ? "pass" : "fail",
      reason: `${channel}: child read of ${path} was denied${fired}`,
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
  paths: DecidePaths,
  plant: DecidePlant = { plantedHalves: [], unplantable: [] },
): Verdict {
  switch (arm) {
    case "parent-turn":
      return leakVerdict(marker ?? "", evidence, "parent turn");
    case "hooks-and-memory":
      return withUnplantable(leakVerdict(marker ?? "", evidence, "hooks and memory"), plant, "hooks and memory");
    case "auto-loaded-instructions":
      return instructionsVerdict(evidence);
    case "transcript-on-disk":
      return deniedReadVerdict(evidence, paths.transcriptPath, paths.workspace, "transcript on disk", true, false);
    case "role-file-denied":
      return deniedReadVerdict(evidence, paths.rolePath, paths.workspace, "role file denied", true, true);
  }
  return { kind: "unobservable", reason: "unrecognized arm" };
}
