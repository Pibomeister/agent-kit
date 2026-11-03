import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { extractSpawn, findClaudeChild, findCodexChild } from "../src/review-isolation-probe/children.ts";
import { readEvidence } from "../src/review-isolation-probe/evidence.ts";
import { claudeProjectSlug } from "../src/review-isolation-probe/hosts.ts";
import { isMarker, newMarker } from "../src/review-isolation-probe/marker.ts";
import { renderNote } from "../src/review-isolation-probe/note.ts";
import { plantArm } from "../src/review-isolation-probe/plant.ts";
import { parseProbeReport, runProbe } from "../src/review-isolation-probe/run.ts";
import type { ProbeReport } from "../src/review-isolation-probe/types.ts";
import { decideArm, type DecidePaths } from "../src/review-isolation-probe/verdict.ts";
import { processScratch } from "./helpers/process-tmp.ts";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "review-isolation-probe.sh");
const FIXTURES = join(REPO, "tests/fixtures/review-isolation-probe");
const ROLE = join(REPO, "roles/doc-review/coherence/ROLE.md");

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: (text: string) => {
      out.push(text);
    },
    err: (text: string) => {
      err.push(text);
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

function envFor(work: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AK_REVIEW_ISOLATION_PROBE: "1",
    AK_PROBE_WORK: work,
    AK_PROBE_FACTS_ROOT: join(work, "facts"),
    AK_PROBE_DATE: "2026-11-03",
    AK_PROBE_JSON: join(work, "verdict.json"),
    AK_PROBE_ROLE: ROLE,
    AK_PROBE_HOST_TIMEOUT_MS: "3000",
    ...extra,
  };
}

function runCli(host: string, extra: NodeJS.ProcessEnv = {}) {
  const work = processScratch("ak-review-iso-");
  made.push(work);
  const sink = io();
  const status = runProbe([host], envFor(work, extra), sink);
  const verdictPath = join(work, "verdict.json");
  return { status, work, report: readReport(verdictPath), stdout: sink.stdout(), stderr: sink.stderr() };
}

function readReport(path: string): ProbeReport | null {
  if (!existsSync(path)) return null;
  return parseProbeReport(readFileSync(path, "utf8"));
}

function runScript(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const work = processScratch("ak-review-iso-sh-");
  made.push(work);
  // spawnSync waits; timeout sends SIGKILL and still waits for the process to exit.
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: envFor(work, extra),
  });
  return { ...result, work };
}

describe("marker generation", () => {
  test("each marker is MARKER_ plus 32 lowercase hex and two calls differ", () => {
    const a = newMarker();
    const b = newMarker();
    expect(isMarker(a)).toBe(true);
    expect(isMarker(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(isMarker("MARKER_zzzz")).toBe(false);
    expect(isMarker(`MARKER_${"a".repeat(32)}`.toUpperCase())).toBe(false);
  });
});

describe("verdict logic", () => {
  const marker = `MARKER_${"ab".repeat(16)}`;
  const transcriptPath = "/tmp/parent-session.jsonl";
  const at: DecidePaths = { rolePath: ROLE, transcriptPath, workspace: "/tmp" };

  test("a leak in child context fails; a marker only in the answer does not", () => {
    const leaked = readEvidence(`{"type":"user","message":{"content":"${marker}"}}\n`, null);
    expect(decideArm("parent-turn", marker, leaked, at).kind).toBe("fail");
    const answerOnly = readEvidence(
      `{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"${marker}"}]}}\n`,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean"}`,
    );
    const decided = decideArm("parent-turn", marker, answerOnly, at);
    expect(decided.kind).toBe("pass");
    expect(decided.reason).toContain("answer mentioned it");
  });

  test("missing transcript and launch is unobservable, not a pass", () => {
    const empty = readEvidence(null, null);
    expect(decideArm("parent-turn", marker, empty, at).kind).toBe("unobservable");
    expect(decideArm("hooks-and-memory", marker, empty, at).kind).toBe("unobservable");
  });

  test("auto-loaded instructions are recorded with the files that arrived", () => {
    const evidence = readEvidence(
      `{"type":"system","subtype":"init","memory_paths":["/work/CLAUDE.md","/work/AGENTS.md"]}\n`,
      null,
    );
    const decided = decideArm("auto-loaded-instructions", marker, evidence, at);
    expect(decided.kind).toBe("recorded");
    expect(decided.reason).toContain("CLAUDE.md");
    expect(decided.reason).toContain("AGENTS.md");
  });

  test("role-file-denied requires a denied read and the whole final answer exactly RESOURCE_UNREADABLE", () => {
    const denied = readEvidence(
      [
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"${ROLE}"}}]}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":true,"content":"nope"}]}}`,
        `{"type":"assistant","message":{"content":[{"type":"text","text":"RESOURCE_UNREADABLE"}]}}`,
      ].join("\n"),
      `{"source":"host-spawn","resume":false}`,
    );
    expect(decideArm("role-file-denied", null, denied, at).kind).toBe("pass");
    const allowed = readEvidence(
      [
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"${transcriptPath}"}}]}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":false,"content":"${marker}"}]}}`,
      ].join("\n"),
      null,
    );
    expect(decideArm("transcript-on-disk", marker, allowed, at).kind).toBe("fail");
  });

  test("a denied role-file read whose final answer is not exactly RESOURCE_UNREADABLE fails", () => {
    const denied = readEvidence(
      [
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"${ROLE}"}}]}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":true,"content":"nope"}]}}`,
        `{"type":"assistant","message":{"content":[{"type":"text","text":"I could not read it"}]}}`,
      ].join("\n"),
      `{"source":"host-spawn","resume":false}`,
    );
    expect(decideArm("role-file-denied", null, denied, at).kind).toBe("fail");
    const lastLineOnly = readEvidence(
      [
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"${ROLE}"}}]}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":true,"content":"nope"}]}}`,
        `{"type":"assistant","message":{"content":[{"type":"text","text":"I tried.\\nRESOURCE_UNREADABLE"}]}}`,
      ].join("\n"),
      `{"source":"host-spawn","resume":false}`,
    );
    expect(lastLineOnly.finalAnswerText.trim()).not.toBe("RESOURCE_UNREADABLE");
    expect(decideArm("role-file-denied", null, lastLineOnly, at).kind).toBe("fail");
  });

  test("host spawn arguments that are absent make a clean leak arm unobservable, not a pass", () => {
    const evidence = readEvidence(
      `{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"UNKNOWN"}]}}\n`,
      `{"source":"absent"}`,
    );
    const decided = decideArm("parent-turn", marker, evidence, at);
    expect(decided.kind).toBe("unobservable");
    expect(decided.reason).toContain("spawn arguments were not observed");
  });

  test("an unplantable hooks-and-memory half is unobservable even when the planted half is clean", () => {
    const evidence = readEvidence(
      `{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"UNKNOWN"}]}}\n`,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean"}`,
    );
    const decided = decideArm("hooks-and-memory", marker, evidence, at, {
      plantedHalves: ["session-start-hook"],
      unplantable: [{ half: "memory-plugin", reason: "MEMORY.md is not auto-loaded" }],
    });
    expect(decided.kind).toBe("unobservable");
    expect(decided.reason).toContain("memory-plugin");
  });

  test("a resume or fork in the launch configuration fails a leak arm", () => {
    const evidence = readEvidence(
      `{"type":"system","subtype":"init"}\n`,
      `{"source":"host-spawn","resume":true,"childPrompt":"x"}`,
    );
    expect(decideArm("parent-turn", marker, evidence, at).kind).toBe("fail");
  });

  test("an unparsed transcript that contains the marker is unobservable", () => {
    const evidence = readEvidence(`plain text holding ${marker}\n`, null);
    expect(decideArm("hooks-and-memory", marker, evidence, at).kind).toBe("unobservable");
  });

  test("a parent prompt recorded in the launch JSON is not a child-context leak", () => {
    const evidence = readEvidence(
      `{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"UNKNOWN"}]}}\n`,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean","prompt":"parent-only ${marker}"}`,
    );
    expect(decideArm("parent-turn", marker, evidence, at).kind).toBe("pass");
  });

  test("a clean launch without a child transcript is unobservable, not a pass", () => {
    const evidence = readEvidence(
      null,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean"}`,
    );
    expect(decideArm("parent-turn", marker, evidence, at).kind).toBe("unobservable");
  });

  test("Codex assistant output is the answer; user input_text is context", () => {
    const answerOnly = readEvidence(
      `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"${marker}"}]}}\n`,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean"}`,
    );
    expect(decideArm("parent-turn", marker, answerOnly, at).kind).toBe("pass");
    const leaked = readEvidence(
      `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${marker}"}]}}\n`,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean"}`,
    );
    expect(decideArm("parent-turn", marker, leaked, at).kind).toBe("fail");
  });

  test("transcript-on-disk on Codex scores CommandExecution, not the answer", () => {
    const denied = readEvidence(
      `{"type":"event_msg","payload":{"item":{"type":"CommandExecution","status":"failed","exit_code":1,"aggregated_output":"","parsed_cmd":[{"type":"read","path":"${transcriptPath}"}]}}}\n{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"RESOURCE_UNREADABLE"}]}}\n`,
      null,
    );
    expect(decideArm("transcript-on-disk", marker, denied, at).kind).toBe("pass");
    const allowed = readEvidence(
      `{"type":"event_msg","payload":{"item":{"type":"CommandExecution","status":"completed","exit_code":0,"aggregated_output":"${marker}","parsed_cmd":[{"type":"read","path":"${transcriptPath}"}]}}}\n`,
      null,
    );
    expect(decideArm("transcript-on-disk", marker, allowed, at).kind).toBe("fail");
    const unplantable = {
      plantedHalves: [],
      unplantable: [{ half: "r3.5-pre-tool-use-guard", reason: "codex" }],
    };
    expect(decideArm("transcript-on-disk", marker, denied, at, unplantable, "codex").kind).toBe("unobservable");
    expect(decideArm("transcript-on-disk", marker, allowed, at, unplantable, "codex").kind).toBe("unobservable");
  });

  test("PreToolUse fired counts only hook payloads from the child session", () => {
    const transcript = [
      `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"${transcriptPath}"}}]}}`,
      `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":true,"content":"denied"}]}}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"RESOURCE_UNREADABLE"}]}}`,
    ].join("\n");
    const parentLog = JSON.stringify({
      session_id: "parent-session",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/other.md" },
    });
    const childLog = JSON.stringify({
      session_id: "parent-session",
      agent_id: "child-agent",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: transcriptPath },
    });
    const parentOnly = readEvidence(transcript, `{"source":"host-spawn","resume":false}`, {
      preToolUseLog: parentLog,
      childIds: ["child-agent"],
      parentSessionId: "parent-session",
    });
    expect(parentOnly.preToolUseFired).not.toBe(true);
    expect(decideArm("transcript-on-disk", marker, parentOnly, at).reason).not.toContain(
      "PreToolUse fired for the subagent call",
    );
    const childHook = readEvidence(transcript, `{"source":"host-spawn","resume":false}`, {
      preToolUseLog: `${parentLog}\n${childLog}`,
      childIds: ["child-agent"],
      parentSessionId: "parent-session",
    });
    expect(childHook.preToolUseFired).toBe(true);
    expect(decideArm("transcript-on-disk", marker, childHook, at).reason).toContain(
      "PreToolUse fired for the subagent call",
    );
  });

  test("a Claude leak-arm pass names that freshness is the absence of resume/fork", () => {
    const evidence = readEvidence(
      `{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"UNKNOWN"}]}}\n`,
      `{"source":"host-spawn","resume":false,"childPrompt":"clean"}`,
    );
    const decided = decideArm(
      "parent-turn",
      marker,
      evidence,
      at,
      { plantedHalves: [], unplantable: [] },
      "claude-code",
    );
    expect(decided.kind).toBe("pass");
    expect(decided.reason).toContain("absence of resume/fork");
    expect(decided.reason).toContain("not a positive attestation");
  });
});

describe("opt-in and host selection", () => {
  test("refuses without AK_REVIEW_ISOLATION_PROBE=1", () => {
    const work = processScratch("ak-review-iso-");
    made.push(work);
    const sink = io();
    const status = runProbe(["claude-code"], envFor(work, { AK_REVIEW_ISOLATION_PROBE: "0" }), sink);
    expect(status).toBe(2);
    expect(sink.stderr()).toContain("AK_REVIEW_ISOLATION_PROBE=1");
    expect(existsSync(join(work, "verdict.json"))).toBe(false);
  });

  test("rejects an unknown host", () => {
    const work = processScratch("ak-review-iso-");
    made.push(work);
    const sink = io();
    const status = runProbe(["grok"], envFor(work), sink);
    expect(status).toBe(2);
    expect(sink.stderr()).toContain("mastracode");
    expect(sink.stderr()).toContain("grok");
  });
});

describe("fixture driver note writing", () => {
  test("claude-code clean fixtures pass leak arms, record instructions, and write a dated note", () => {
    const r = runCli("claude-code", { AK_PROBE_FIXTURE_DIR: join(FIXTURES, "clean") });
    expect(r.status).toBe(0);
    expect(r.report).not.toBeNull();
    if (r.report === null) return;
    expect(r.report.driver).toBe("fixture");
    expect(r.report.hostVersion).toContain("not invoked");
    const byId = new Map(r.report.arms.map((arm) => [arm.id, arm]));
    expect(byId.get("parent-turn")?.verdict).toBe("pass");
    expect(byId.get("parent-turn")?.reason).toContain("absence of resume/fork");
    expect(byId.get("hooks-and-memory")?.verdict).toBe("unobservable");
    expect(byId.get("hooks-and-memory")?.reason).toContain("memory-plugin");
    expect(byId.get("auto-loaded-instructions")?.verdict).toBe("recorded");
    expect(byId.get("auto-loaded-instructions")?.reason).toContain("CLAUDE.md");
    expect(byId.get("transcript-on-disk")?.verdict).toBe("pass");
    expect(byId.get("role-file-denied")?.verdict).toBe("pass");
    const parentMarker = byId.get("parent-turn")?.marker;
    expect(parentMarker !== null && parentMarker !== undefined && isMarker(parentMarker)).toBe(true);
    expect(byId.get("role-file-denied")?.marker).toBeNull();
    const note = join(r.work, "facts", "2026-11-03", "review-isolation-claude-code.md");
    expect(existsSync(note)).toBe(true);
    const text = readFileSync(note, "utf8");
    expect(text).toContain("Child sessions under");
    expect(text).toContain("absence of resume/fork");
    expect(text).toContain("| parent-turn |");
    expect(text).toContain("| role-file-denied |");
    expect(renderNote(r.report)).toContain("unobservable");
  });

  test("leaking fixtures fail the channels that leaked and still record instructions", () => {
    const r = runCli("claude-code", { AK_PROBE_FIXTURE_DIR: join(FIXTURES, "leak") });
    expect(r.status).toBe(0);
    if (r.report === null) throw new Error("expected a verdict file");
    const byId = new Map(r.report.arms.map((arm) => [arm.id, arm]));
    expect(byId.get("parent-turn")?.verdict).toBe("fail");
    expect(byId.get("hooks-and-memory")?.verdict).toBe("fail");
    expect(byId.get("auto-loaded-instructions")?.verdict).toBe("recorded");
    expect(byId.get("transcript-on-disk")?.verdict).toBe("fail");
    expect(byId.get("role-file-denied")?.verdict).toBe("fail");
  });

  test("mastracode without a child transcript is unobservable on every arm that needs one", () => {
    const r = runCli("mastracode", { AK_PROBE_FIXTURE_DIR: join(FIXTURES, "missing") });
    expect(r.status).toBe(0);
    if (r.report === null) throw new Error("expected a verdict file");
    expect(r.stderr).toContain("No adapter");
    for (const arm of r.report.arms) {
      if (arm.id === "auto-loaded-instructions") {
        expect(arm.verdict).toBe("unobservable");
        continue;
      }
      expect(arm.verdict).toBe("unobservable");
    }
    const note = readFileSync(r.report.notePath, "utf8");
    expect(note).toContain("unobservable");
    expect(note).toContain("mastracode");
  });

  test("codex fixtures record that the transcript channel is observed as a child command", () => {
    const r = runCli("codex", { AK_PROBE_FIXTURE_DIR: join(FIXTURES, "clean") });
    expect(r.status).toBe(0);
    if (r.report === null) throw new Error("expected a verdict file");
    expect(r.stderr).toContain("CS-12");
    expect(readFileSync(r.report.notePath, "utf8")).toContain("CommandExecution");
    const byId = new Map(r.report.arms.map((arm) => [arm.id, arm]));
    expect(byId.get("transcript-on-disk")?.verdict).toBe("unobservable");
  });

  test("answer-only fixtures pass the leak arm because the child's answer is ignored", () => {
    const r = runCli("claude-code", { AK_PROBE_FIXTURE_DIR: join(FIXTURES, "answer-only") });
    expect(r.status).toBe(0);
    if (r.report === null) throw new Error("expected a verdict file");
    const parent = r.report.arms.find((arm) => arm.id === "parent-turn");
    expect(parent?.verdict).toBe("pass");
    expect(parent?.reason).toContain("answer mentioned it");
  });
});

describe("the shell wrapper", () => {
  test("refuses without the opt-in flag", () => {
    const r = runScript(["claude-code"], { AK_REVIEW_ISOLATION_PROBE: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("AK_REVIEW_ISOLATION_PROBE=1");
  });

  test("rejects an unknown host", () => {
    const r = runScript(["not-a-host"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not-a-host");
  });

  test("fixture driver writes the note and does not spawn a host binary", () => {
    const r = runScript(["claude-code"], { AK_PROBE_FIXTURE_DIR: join(FIXTURES, "clean") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("review-isolation-probe: verdict");
    expect(existsSync(join(r.work, "facts", "2026-11-03", "review-isolation-claude-code.md"))).toBe(true);
    expect(r.stdout).toContain("fixture (host CLI not invoked)");
  });
});

describe("stubbed host CLI (live driver, no model)", () => {
  test("a stub claude that writes a child jsonl is scored from that file, not from its printed answer", () => {
    const work = processScratch("ak-review-iso-stub-");
    made.push(work);
    const bin = join(work, "bin");
    mkdirSync(bin);
    const stub = `#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("0.0.0 (stub)"); process.exit(0); }
const cfg = process.env.CLAUDE_CONFIG_DIR;
if (cfg === undefined) process.exit(1);
const session = process.argv[process.argv.indexOf("--session-id") + 1];
const dir = join(cfg, "projects");
mkdirSync(dir, { recursive: true });
const projects = join(cfg, "projects");
mkdirSync(projects, { recursive: true });
const encoded = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const sub = join(projects, encoded, session, "subagents");
mkdirSync(sub, { recursive: true });
const role = process.env.AK_PROBE_ROLE ?? "ROLE.md";
writeFileSync(join(sub, "agent-1.jsonl"), JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"1",name:"Read",input:{file_path:role}}]}}) + "\\n" + JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"1",is_error:true,content:"denied"}]}}) + "\\n" + JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"RESOURCE_UNREADABLE"}]}}) + "\\n");
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",name:"Agent",input:{prompt:"child task",resume:false,fork_turns:"none"}}]}}));
process.exit(0);
`;
    writeFileSync(join(bin, "claude"), stub);
    chmodSync(join(bin, "claude"), 0o755);
    const sink = io();
    const status = runProbe(["claude-code"], envFor(work, { PATH: `${bin}:${process.env.PATH ?? ""}` }), sink);
    expect(status).toBe(0);
    const report = readReport(join(work, "verdict.json"));
    if (report === null) throw new Error("expected a verdict file");
    expect(report.driver).toBe("live");
    expect(report.hostVersion).toContain("0.0.0");
    const roleArm = report.arms.find((arm) => arm.id === "role-file-denied");
    expect(roleArm?.verdict).toBe("pass");
  });

  test("live mastracode with no binary is unobservable on every arm and spawns nothing billed", () => {
    const work = processScratch("ak-review-iso-mastra-");
    made.push(work);
    const bin = join(work, "empty-bin");
    mkdirSync(bin);
    const sink = io();
    const status = runProbe(["mastracode"], envFor(work, { PATH: bin }), sink);
    expect(status).toBe(0);
    const report = readReport(join(work, "verdict.json"));
    if (report === null) throw new Error("expected a verdict file");
    expect(report.driver).toBe("live");
    expect(report.commands).toEqual([]);
    for (const arm of report.arms) expect(arm.verdict).toBe("unobservable");
    expect(sink.stderr()).toContain("No adapter");
  });
});

const REVIEW_R1 = join(FIXTURES, "review-r1");

function fillFixture(text: string, marker: string): string {
  return text.replaceAll("{{MARKER}}", marker).replaceAll("{{ROLE}}", ROLE);
}

describe("review-round-1 fixtures", () => {
  const marker = `MARKER_${"cd".repeat(16)}`;
  const at: DecidePaths = { rolePath: ROLE, transcriptPath: "/tmp/parent-session.jsonl", workspace: "/tmp/arm-work" };

  test("(a) a forked or resumed spawn in the host transcript must not pass", () => {
    const transcript = readFileSync(join(REVIEW_R1, "a-forked-spawn/child.jsonl"), "utf8");
    const launch = readFileSync(join(REVIEW_R1, "a-forked-spawn/launch.json"), "utf8");
    const evidence = readEvidence(transcript, launch);
    expect(evidence.freshSubagent).toBe(false);
    expect(decideArm("parent-turn", marker, evidence, at).kind).toBe("fail");
    const forked = readEvidence(
      `{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","arguments":"{\\"fork_context\\":true,\\"prompt\\":\\"x\\"}"}}\n`,
      null,
    );
    expect(decideArm("parent-turn", marker, forked, at).kind).toBe("fail");
  });

  test("(b) a Codex stream with parent and child threads selects the child", () => {
    const home = join(REVIEW_R1, "b-codex-threads");
    const stdout = readFileSync(join(home, "stdout.jsonl"), "utf8");
    const child = findCodexChild(home, stdout);
    expect(child).not.toBeNull();
    expect(child).toContain("CHILD_THREAD");
    expect(child).not.toContain("PARENT_THREAD_ONLY");
    expect(child).not.toContain("UNRELATED_JSONL");
    const spawn = extractSpawn(`${stdout}\n${child ?? ""}`);
    expect(spawn.childThreadIds).toEqual(["thread_child_bbbb"]);
    expect(spawn.parentThreadId).toBe("thread_parent_aaaa");
  });

  test("(c) Claude with no subagent file is unobservable", () => {
    const work = processScratch("ak-review-iso-nosub-");
    made.push(work);
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    const configDir = join(work, "config");
    const sessionId = "session-parent-only";
    const project = join(configDir, "projects", claudeProjectSlug(workspace));
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, `${sessionId}.jsonl`),
      readFileSync(join(REVIEW_R1, "c-claude-parent-only/parent.jsonl")),
    );
    expect(findClaudeChild(configDir, workspace, sessionId)).toBeNull();
    const evidence = readEvidence(
      null,
      `{"source":"host-spawn","resume":false,"fork_turns":"none","childPrompt":"clean"}`,
    );
    expect(decideArm("parent-turn", marker, evidence, at).kind).toBe("unobservable");
  });

  test("(d) the parent-turn marker only in the parent argv must not fail", () => {
    const transcript = readFileSync(join(REVIEW_R1, "d-parent-argv/child.jsonl"), "utf8");
    const launch = fillFixture(readFileSync(join(REVIEW_R1, "d-parent-argv/launch.json"), "utf8"), marker);
    const evidence = readEvidence(transcript, launch);
    expect(evidence.contextText).not.toContain(marker);
    expect(decideArm("parent-turn", marker, evidence, at).kind).toBe("pass");
  });

  test("(e) role-file denied but the answer is not exactly RESOURCE_UNREADABLE must fail", () => {
    const transcript = fillFixture(
      readFileSync(join(REVIEW_R1, "e-role-denied-wrong-answer/child.jsonl"), "utf8"),
      marker,
    );
    const evidence = readEvidence(transcript, `{"source":"host-spawn","resume":false}`);
    expect(decideArm("role-file-denied", null, evidence, at).kind).toBe("fail");
  });

  test("two Claude subagent files join on the Agent tool id, or are unobservable if unjoined", () => {
    const work = processScratch("ak-review-iso-twosub-");
    made.push(work);
    const workspace = join(work, "ws");
    mkdirSync(workspace);
    const configDir = join(work, "config");
    const sessionId = "session-two";
    const sub = join(configDir, "projects", claudeProjectSlug(workspace), sessionId, "subagents");
    mkdirSync(sub, { recursive: true });
    const fixture = join(REVIEW_R1, "two-subagents");
    writeFileSync(join(sub, "agent-wanted.jsonl"), readFileSync(join(fixture, "subagents/agent-wanted.jsonl")));
    writeFileSync(join(sub, "agent-other.jsonl"), readFileSync(join(fixture, "subagents/agent-other.jsonl")));
    const joined = findClaudeChild(
      configDir,
      workspace,
      sessionId,
      readFileSync(join(fixture, "parent.jsonl"), "utf8"),
    );
    expect(joined).not.toBeNull();
    expect(joined).toContain("CHILD_WANTED");
    expect(joined).not.toContain("CHILD_OTHER");
    const unjoined = findClaudeChild(
      configDir,
      workspace,
      sessionId,
      readFileSync(join(fixture, "parent-unjoined.jsonl"), "utf8"),
    );
    expect(unjoined).toBeNull();
  });

  test("(f) a relative or short touch path must not match the role file", () => {
    const transcript = readFileSync(join(REVIEW_R1, "f-short-touch/child.jsonl"), "utf8");
    const evidence = readEvidence(transcript, `{"source":"host-spawn","resume":false}`);
    expect(decideArm("role-file-denied", null, evidence, at).kind).toBe("unobservable");
    const relative = readEvidence(
      [
        `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"ROLE.md"}}]}}`,
        `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"1","is_error":true,"content":"denied"}]}}`,
        `{"type":"assistant","message":{"content":[{"type":"text","text":"RESOURCE_UNREADABLE"}]}}`,
      ].join("\n"),
      `{"source":"host-spawn","resume":false}`,
    );
    expect(decideArm("role-file-denied", null, relative, at).kind).toBe("unobservable");
  });
});

describe("plantArm stays inside the temp workspace", () => {
  test("hooks-and-memory plants a Claude SessionStart hook, writes no MEMORY.md, and scores the rest unplantable", () => {
    const work = processScratch("ak-review-iso-plant-");
    made.push(work);
    const claude = plantArm("claude-code", "hooks-and-memory", join(work, "claude"), `MARKER_${"ee".repeat(16)}`, ROLE);
    expect(existsSync(join(claude.workspace, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(claude.workspace, "session-start.sh"))).toBe(true);
    expect(readFileSync(claude.settingsPath, "utf8")).toContain("SessionStart");
    expect(claude.plantedHalves).toContain("session-start-hook");
    expect(claude.unplantable.some((row) => row.half === "memory-plugin")).toBe(true);
    const codex = plantArm("codex", "hooks-and-memory", join(work, "codex"), `MARKER_${"ff".repeat(16)}`, ROLE);
    expect(existsSync(join(codex.workspace, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(codex.workspace, "session-start.sh"))).toBe(false);
    expect(codex.unplantable.some((row) => row.half === "session-start-hook")).toBe(true);
    expect(codex.unplantable.some((row) => row.half === "memory-plugin")).toBe(true);
  });

  test("transcript-on-disk wires the R3.5 PreToolUse guard into the arm's temp settings only", () => {
    const work = processScratch("ak-review-iso-guard-");
    made.push(work);
    const planted = plantArm("claude-code", "transcript-on-disk", join(work, "arm"), `MARKER_${"aa".repeat(16)}`, ROLE);
    expect(planted.preToolUseLogPath).not.toBeNull();
    expect(existsSync(join(planted.workspace, "review-session.policy.json"))).toBe(true);
    expect(readFileSync(join(planted.workspace, "review-session.policy.json"), "utf8")).toContain(
      "secret.claude-session-store",
    );
    expect(readFileSync(planted.settingsPath, "utf8")).toContain("PreToolUse");
    const hook = readFileSync(join(planted.workspace, "pre-tool-use.sh"), "utf8");
    expect(hook).toContain("guard hook pre-tool-use");
    expect(hook).toContain('"agent_id":');
    expect(hook).toContain(join(planted.workspace, "review-session.policy.json"));
    expect(planted.plantedHalves).toContain("r3.5-pre-tool-use-guard");
    expect(readFileSync(join(REPO, "templates/guard/review-session.policy.json"), "utf8")).toContain(
      "**/.claude/projects/**",
    );
    expect(planted.transcriptPath.startsWith(join(planted.workspace, ".claude", "projects"))).toBe(true);
  });
});
