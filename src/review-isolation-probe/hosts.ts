/**
 * What each host exposes for the review-isolation probe, and how a live arm
 * would dispatch a fresh generic subagent the way doc-review does.
 *
 * mastracode has no adapter on main: there is no CLI dispatch path to invoke,
 * and child transcripts are unobservable unless a fixture or an operator-supplied
 * file provides them. That is recorded rather than scored as a pass.
 */
import type { ArmId, ProbeHost } from "./types.ts";

export interface HostProfile {
  id: ProbeHost;
  binaries: readonly string[];
  versionArgs: readonly string[];
  exposes: string;
  /** Per-arm: where the probe looks, or why it cannot look. */
  channels: Record<ArmId, string>;
}

export const HOST_PROFILES: Record<ProbeHost, HostProfile> = {
  "claude-code": {
    id: "claude-code",
    binaries: ["claude"],
    versionArgs: ["--version"],
    exposes:
      "Child sessions under $CLAUDE_CONFIG_DIR/projects/<encoded-workspace>/<session>/subagents/agent-*.jsonl, plus the Agent tool's launch input in the parent trace. Init events list plugins, skills and memory_paths.",
    channels: {
      "parent-turn": "child jsonl under projects/<workspace>/<session>/subagents/; Agent input prompt",
      "hooks-and-memory": "child jsonl and init/memory_paths; SessionStart additionalContext in the child trace",
      "auto-loaded-instructions": "system/init memory_paths and names of CLAUDE.md / AGENTS.md in the child trace",
      "transcript-on-disk": "child Read tool_result is_error against the parent session jsonl",
      "role-file-denied": "child Read tool_result is_error against the role file",
    },
  },
  codex: {
    id: "codex",
    binaries: ["codex"],
    versionArgs: ["--version"],
    exposes:
      "Child threads as $CODEX_HOME/sessions/**/*<thread_id>.jsonl, joined from SubAgentActivity started events. spawn_agent arguments (fork_context / fork_turns) are the launch configuration. File reads appear as CommandExecution, not a Read tool. The package guard does not cover this host (CS-12), so the transcript-on-disk channel is observed only as a child command, never as a denied hook.",
    channels: {
      "parent-turn": "child session jsonl and spawn_agent arguments",
      "hooks-and-memory": "child session jsonl; launch -c features.hooks / features.memories",
      "auto-loaded-instructions":
        "AGENTS.md in the child trace or prompt-input; unobservable when those events are absent",
      "transcript-on-disk":
        "child CommandExecution of the parent session path; no package hook will deny it on this host",
      "role-file-denied":
        "child CommandExecution of the role file; this host has no per-read deny in the dispatch used here, so the arm is unobservable unless the transcript already shows a denial",
    },
  },
  mastracode: {
    id: "mastracode",
    binaries: ["mastracode", "mastra"],
    versionArgs: ["--version"],
    exposes:
      "No adapter and no CLI dispatch path in this package. Review seats would be read-only custom subagents (createMastraCode({ subagents })), or AcpAgent with persistSession false if observational memory is shared. Child transcripts are not a documented session-store path here; arms stay unobservable until a fixture or an operator-supplied child transcript is provided.",
    channels: {
      "parent-turn": "unobservable unless a child transcript is supplied",
      "hooks-and-memory":
        "the arm to watch (observational memory); unobservable without a child transcript that shows injection",
      "auto-loaded-instructions": "unobservable without a child transcript or launch config naming those files",
      "transcript-on-disk": "unobservable; no session-store path is documented for this host in the package",
      "role-file-denied": "unobservable without a child transcript that records a denied role-file read",
    },
  },
};

export function profileFor(host: ProbeHost): HostProfile {
  return HOST_PROFILES[host];
}

/** Encode a workspace path the way Claude Code names project directories. */
export function claudeProjectSlug(workspace: string): string {
  let out = "";
  for (const char of workspace) {
    const code = char.charCodeAt(0);
    const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    out += alnum ? char : "-";
  }
  return out;
}
