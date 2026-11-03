import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";

import { dispatchArm, hostVersion } from "./dispatch.ts";
import { readEvidence } from "./evidence.ts";
import { profileFor } from "./hosts.ts";
import { newMarker } from "./marker.ts";
import { writeNote } from "./note.ts";
import { plantArm } from "./plant.ts";
import type { ArmId, ArmResult, ProbeHost, ProbeIo, ProbeReport } from "./types.ts";
import { ARM_IDS, isProbeHost } from "./types.ts";
import { decideArm } from "./verdict.ts";

const reportValidator: ValidateFunction<ProbeReport> = new Ajv2020({ strict: false }).compile({
  type: "object",
  additionalProperties: true,
  required: ["host", "hostVersion", "driver", "arms", "notePath", "verdictPath", "work", "date"],
  properties: {
    host: { type: "string" },
    hostVersion: { type: "string" },
    pluginsAndHooks: { type: "string" },
    date: { type: "string" },
    driver: { type: "string", enum: ["live", "fixture"] },
    commands: { type: "array", items: { type: "string" } },
    work: { type: "string" },
    verdictPath: { type: "string" },
    notePath: { type: "string" },
    arms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "verdict", "reason"],
        properties: {
          id: { type: "string" },
          marker: { type: ["string", "null"] },
          verdict: { type: "string" },
          reason: { type: "string" },
          loadedFiles: { type: "array", items: { type: "string" } },
          childTranscript: { type: ["string", "null"] },
          launchConfig: { type: ["string", "null"] },
        },
      },
    },
  },
});

export function parseProbeReport(text: string): ProbeReport | null {
  try {
    // SAFETY: JSON.parse is any; reportValidator is the contract before use.
    const value = JSON.parse(text) as unknown;
    return reportValidator(value) ? value : null;
  } catch {
    return null;
  }
}

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const DEFAULT_ROLE = join(REPO, "roles/doc-review/coherence/ROLE.md");

export const USAGE = `review-isolation-probe: opt-in, live, billed. Usage:

  AK_REVIEW_ISOLATION_PROBE=1 scripts/review-isolation-probe.sh <host>

Hosts: claude-code, codex, mastracode.

Refuses without AK_REVIEW_ISOLATION_PROBE=1 so CI and bun test cannot bill a
host. Extra arguments are not passed through.

Environment:
  AK_PROBE_JSON            verdict JSON path (default: <work>/verdict.json)
  AK_PROBE_FACTS_ROOT      research/host-facts parent (default: <repo>/research/host-facts)
  AK_PROBE_DATE            note date YYYY-MM-DD (default: UTC today)
  AK_PROBE_WORK            working directory (default: a temp directory)
  AK_PROBE_FIXTURE_DIR     offline driver: per-arm child.jsonl + launch.json
  AK_PROBE_ROLE            role file the child is told to read
  AK_PROBE_HOST_TIMEOUT_MS live host timeout (default: 600000)
`;

function envValue(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (value === undefined || value === "") return null;
  return value;
}

function utcDate(now: Date): string {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseTimeout(value: string | null): number {
  if (value === null) return 600_000;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return 600_000;
}

function sessionId(): string {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function fill(text: string, marker: string, rolePath: string, transcriptPath: string): string {
  return text
    .replaceAll("{{MARKER}}", marker)
    .replaceAll("{{ROLE}}", rolePath)
    .replaceAll("{{TRANSCRIPT}}", transcriptPath);
}

function readFilled(path: string, marker: string, rolePath: string, transcriptPath: string): string | null {
  try {
    return fill(readFileSync(path, "utf8"), marker, rolePath, transcriptPath);
  } catch {
    return null;
  }
}

function pluginsLine(host: ProbeHost, work: string, driver: "live" | "fixture"): string {
  if (driver === "fixture") return "fixture (host settings not read)";
  if (host === "mastracode") return "not observed (no adapter CLI)";
  try {
    return readFileSync(join(work, "cfg", "settings.json"), "utf8").trim() || "empty settings";
  } catch {
    return "settings.json not present";
  }
}

interface FixtureFiles {
  transcript: string | null;
  launch: string | null;
}

function fixtureArm(
  fixtureDir: string,
  arm: ArmId,
  marker: string,
  rolePath: string,
  transcriptPath: string,
): FixtureFiles {
  const dir = join(fixtureDir, arm);
  return {
    transcript: readFilled(join(dir, "child.jsonl"), marker, rolePath, transcriptPath),
    launch: readFilled(join(dir, "launch.json"), marker, rolePath, transcriptPath),
  };
}

export function runProbe(argv: readonly string[], env: NodeJS.ProcessEnv, io: ProbeIo): number {
  const help = argv.includes("-h") || argv.includes("--help");
  if (help || argv.length === 0) {
    io.err(USAGE);
    return help ? 0 : 2;
  }
  const hostArg = argv[0];
  if (hostArg === undefined || !isProbeHost(hostArg)) {
    io.err(`review-isolation-probe: host is claude-code, codex or mastracode, not ${hostArg ?? "(missing)"}\n`);
    return 2;
  }
  if (argv.length > 1) {
    io.err("review-isolation-probe: extra arguments are not accepted\n");
    return 2;
  }
  if (envValue(env, "AK_REVIEW_ISOLATION_PROBE") !== "1") {
    io.err("review-isolation-probe: refusing without AK_REVIEW_ISOLATION_PROBE=1 (live, billed)\n");
    return 2;
  }

  const fixtureDir = envValue(env, "AK_PROBE_FIXTURE_DIR");
  const driver = fixtureDir === null ? "live" : "fixture";
  const date = envValue(env, "AK_PROBE_DATE") ?? utcDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    io.err(`review-isolation-probe: AK_PROBE_DATE must be YYYY-MM-DD, not ${date}\n`);
    return 2;
  }
  const factsRoot = envValue(env, "AK_PROBE_FACTS_ROOT") ?? join(REPO, "research/host-facts");
  const work = envValue(env, "AK_PROBE_WORK") ?? mkdtempSync(join(tmpdir(), "ak-review-isolation-"));
  mkdirSync(work, { recursive: true });
  const verdictPath = envValue(env, "AK_PROBE_JSON") ?? join(work, "verdict.json");
  const notePath = join(factsRoot, date, `review-isolation-${hostArg}.md`);
  const rolePath = envValue(env, "AK_PROBE_ROLE") ?? DEFAULT_ROLE;
  const timeoutMs = parseTimeout(envValue(env, "AK_PROBE_HOST_TIMEOUT_MS"));
  const absoluteRole = isAbsolute(rolePath) ? rolePath : resolve(REPO, rolePath);

  const commands: string[] = [];
  const arms: ArmResult[] = [];
  const version = driver === "fixture" ? "fixture (host CLI not invoked)" : hostVersion(hostArg, env);

  for (const arm of ARM_IDS) {
    const plantedMarker = newMarker();
    const armDir = join(work, arm);
    const planted = plantArm(hostArg, arm, armDir, plantedMarker, absoluteRole);
    const usedMarker = planted.marker;

    let transcript: string | null = null;
    let launch: string | null = null;
    let preToolUseLog: string | null = null;
    let childIds: readonly string[] = [];
    let parentSessionId: string | null = null;
    if (fixtureDir !== null) {
      const loaded = fixtureArm(fixtureDir, arm, plantedMarker, absoluteRole, planted.transcriptPath);
      transcript = loaded.transcript;
      launch = loaded.launch;
    } else {
      const dispatched = dispatchArm(hostArg, planted, {
        timeoutMs,
        env,
        configDir: join(armDir, "host-config"),
        sessionId: sessionId(),
      });
      if (dispatched.command.length > 0) commands.push(dispatched.command.join(" "));
      transcript = dispatched.childTranscript;
      launch = dispatched.launchConfig;
      preToolUseLog = dispatched.preToolUseLog;
      childIds = dispatched.childIds;
      parentSessionId = dispatched.parentSessionId;
      writeFileSync(join(armDir, "launch.json"), dispatched.launchConfig);
      if (dispatched.childTranscript !== null) writeFileSync(join(armDir, "child.jsonl"), dispatched.childTranscript);
    }

    const evidence = readEvidence(transcript, launch, {
      preToolUseLog,
      childIds,
      parentSessionId,
    });
    const decided = decideArm(
      arm,
      usedMarker,
      evidence,
      { rolePath: absoluteRole, transcriptPath: planted.transcriptPath, workspace: planted.workspace },
      { plantedHalves: planted.plantedHalves, unplantable: planted.unplantable },
      hostArg,
    );
    if (transcript !== null) writeFileSync(join(armDir, "child.observed.jsonl"), transcript);
    if (launch !== null) writeFileSync(join(armDir, "launch.observed.json"), launch);
    arms.push({
      id: arm,
      marker: usedMarker,
      verdict: decided.kind,
      reason: decided.reason,
      loadedFiles: evidence.loadedFiles,
      childTranscript: transcript === null ? null : join(armDir, "child.observed.jsonl"),
      launchConfig: launch === null ? null : join(armDir, "launch.observed.json"),
    });
  }

  const report: ProbeReport = {
    host: hostArg,
    hostVersion: version,
    pluginsAndHooks: pluginsLine(hostArg, join(work, "parent-turn"), driver),
    date,
    driver,
    commands,
    work,
    verdictPath,
    notePath,
    arms,
  };
  mkdirSync(dirname(verdictPath), { recursive: true });
  writeFileSync(verdictPath, `${JSON.stringify(report, null, 2)}\n`);
  writeNote(report);
  io.out(`${JSON.stringify(report, null, 2)}\n`);
  io.out(`review-isolation-probe: verdict ${verdictPath}, note ${notePath}, work ${work}\n`);
  io.err(`${profileFor(hostArg).exposes}\n`);
  return 0;
}
