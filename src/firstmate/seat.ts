/** Stock Firstmate scout seats for one frozen runner checkpoint. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

import { readAdminToken } from "../runner/token.ts";

interface SeatPacket {
  run: string;
  charter_hash: string;
  revision: string;
  diff_hash: string;
  card: {
    id: string;
    question: string;
    options: string[];
    artifact_hash: string;
    evidence: { id: string; hash: string | null }[];
  };
}

interface SeatAnswer {
  choice: string;
  rationale: string;
}

const ajv = new Ajv2020({ strict: false });
const seatPacket = ajv.compile<SeatPacket>({
  type: "object",
  required: ["run", "charter_hash", "revision", "diff_hash", "card"],
  properties: {
    run: { type: "string" },
    charter_hash: { type: "string" },
    revision: { type: "string" },
    diff_hash: { type: "string" },
    card: {
      type: "object",
      required: ["id", "question", "options", "artifact_hash", "evidence"],
      properties: {
        id: { type: "string" },
        question: { type: "string" },
        options: { type: "array", minItems: 2, items: { type: "string" } },
        artifact_hash: { type: "string" },
        evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["id", "hash"],
            properties: { id: { type: "string" }, hash: { type: ["string", "null"] } },
          },
        },
      },
    },
  },
});
const seatAnswer = ajv.compile<SeatAnswer>({
  type: "object",
  additionalProperties: false,
  required: ["choice", "rationale"],
  properties: { choice: { type: "string", minLength: 1 }, rationale: { type: "string", minLength: 1 } },
});
const ID = /^[a-z0-9][a-z0-9-]*$/;

function privateFile(home: string, path: string): string {
  const at = realpathSync(path);
  const rel = relative(realpathSync(home), at);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the Firstmate home`);
  return at;
}

function packetFrom(home: string, path: string): SeatPacket {
  const value: unknown = JSON.parse(readFileSync(privateFile(home, path), "utf8"));
  if (!seatPacket(value)) throw new Error(`invalid frozen seat packet: ${JSON.stringify(seatPacket.errors)}`);
  if (!ID.test(value.run) || !ID.test(value.card.id) || value.card.evidence.some((item) => item.hash === null))
    throw new Error("seat packet has an invalid id or uncollected evidence");
  return value;
}

function scoutWorktree(home: string, taskId: string): string {
  const meta = readFileSync(privateFile(home, join(home, "state", `${taskId}.meta`)), "utf8");
  const field = (key: string) =>
    meta
      .split("\n")
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1);
  if (field("endpoint_task_id") !== taskId || field("kind") !== "scout" || !field("worktree"))
    throw new Error(`Firstmate did not attest scout task ${taskId}`);
  return field("worktree") ?? "";
}

function runCommand(home: string, argv: string[], extraEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env["AK_RUNNER_ADMIN_TOKEN"];
  delete env["AK_RUNNER_TOKEN"];
  const result = Bun.spawnSync(argv, { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function evidenceText(home: string, directory: string, packet: SeatPacket): string {
  const at = privateFile(home, directory);
  const files = readdirSync(at);
  return packet.card.evidence
    .map((evidence) => {
      const matches = files.filter(
        (name) =>
          name === evidence.id ||
          name.startsWith(`${evidence.id}.`) ||
          name === `${packet.run}-${evidence.id}.evidence`,
      );
      if (matches.length !== 1) throw new Error(`evidence ${evidence.id} needs exactly one private file`);
      const file = privateFile(home, join(at, matches[0] ?? ""));
      const bytes = readFileSync(file);
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (hash !== evidence.hash) throw new Error(`evidence ${evidence.id} does not match its runner hash`);
      return `--- ${evidence.id} (${hash}) ---\n${bytes.toString("utf8")}`;
    })
    .join("\n\n");
}

export interface SeatLaunchArgs {
  fmHome: string;
  taskId: string;
  projectName: string;
  projectDir: string;
  packetPath: string;
  evidenceDir: string;
  captainIntentFile: string;
  implementerWorktree: string;
  harness?: string;
}

export function launchSeat(args: SeatLaunchArgs) {
  if (!ID.test(args.taskId)) throw new Error("seat task id must be lowercase kebab case");
  const home = realpathSync(args.fmHome);
  const packet = packetFrom(home, args.packetPath);
  const intent = readFileSync(privateFile(home, args.captainIntentFile), "utf8").trim();
  if (!intent) throw new Error("seat task needs the captain's intent");
  const evidence = evidenceText(home, args.evidenceDir, packet);
  const brief = join(home, "data", args.taskId, "brief.md");
  if (existsSync(brief) || existsSync(join(home, "state", `${args.taskId}.meta`)))
    throw new Error(`seat task ${args.taskId} already exists`);
  const title = `runner seat judging ${packet.card.id} in ${packet.run}`;
  runCommand(home, [join(home, "bin", "fm-tasks-axi.sh"), "add", args.taskId, "--title", title]);
  runCommand(home, [join(home, "bin", "fm-brief.sh"), args.taskId, args.projectName, "--scout"]);
  const scaffold = readFileSync(brief, "utf8");
  if (scaffold.split("{TASK}").length !== 2 || scaffold.split("{FIRSTMATE_SPEC}").length !== 2)
    throw new Error("Firstmate scout brief has an unexpected shape");
  const spec = `Judge this frozen runner checkpoint independently. You are a separate Firstmate
crewmate, not a child of the implementer. Do not seek the other seat's transcript or verdict.
Inspect ${args.implementerWorktree} read-only if useful.

Frozen card packet:\n${JSON.stringify(packet, null, 2)}

Runner-collected evidence:\n${evidence}

Write a concise report to your normal scout report path. Its final nonempty line must be one JSON
object with exactly choice and rationale, for example {"choice":"${packet.card.options[0]}","rationale":"evidence supports this option"}.
Choose only an id from the frozen options. Report failure rather than guessing when evidence is missing.`;
  const rendered = scaffold.replace(/\{TASK\}|\{FIRSTMATE_SPEC\}/g, (marker) => (marker === "{TASK}" ? intent : spec));
  writeFileSync(brief, rendered);
  const argv = [join(home, "bin", "fm-spawn.sh"), args.taskId, args.projectDir, "--scout"];
  if (args.harness !== undefined) argv.push("--harness", args.harness);
  const spawn = runCommand(home, argv);
  const worktree = scoutWorktree(home, args.taskId);
  if (worktree === args.implementerWorktree) throw new Error("seat reused the implementer worktree");
  return { task_id: args.taskId, run: packet.run, card_id: packet.card.id, brief, worktree, spawn };
}

export interface SeatJudgeArgs {
  fmHome: string;
  taskId: string;
  packetPath: string;
  seat: string;
  actor: string;
  runnerSocket: string;
  adminTokenFile: string;
  akRoot: string;
}

export function judgeSeat(args: SeatJudgeArgs) {
  if (![args.taskId, args.seat, args.actor].every((id) => ID.test(id))) throw new Error("invalid seat identity");
  const home = realpathSync(args.fmHome);
  const packet = packetFrom(home, args.packetPath);
  scoutWorktree(home, args.taskId);
  const report = privateFile(home, join(home, "data", args.taskId, "report.md"));
  const last = readFileSync(report, "utf8").trim().split("\n").at(-1) ?? "";
  const value: unknown = JSON.parse(last);
  if (!seatAnswer(value) || !packet.card.options.includes(value.choice))
    throw new Error("seat report ends without a declared option and rationale");
  const token = readAdminToken(args.adminTokenFile, [home]);
  const request = join(home, "data", args.taskId, `ak-judge-${packet.card.id}.json`);
  const body = {
    run: packet.run,
    card_id: packet.card.id,
    seat: args.seat,
    actor: args.actor,
    dispatch: `fm-${args.taskId}`,
    choice: value.choice,
    rationale: value.rationale,
    input_dispatches: [],
    lineage: [args.actor],
  };
  mkdirSync(join(home, "data", args.taskId), { recursive: true });
  if (existsSync(request) && readFileSync(request, "utf8") !== JSON.stringify(body))
    throw new Error("seat judgment changed after its first submission");
  if (!existsSync(request)) writeFileSync(request, JSON.stringify(body), { flag: "wx", mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, AK_RUNNER_TOKEN: token };
  delete env["AK_RUNNER_ADMIN_TOKEN"];
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(args.akRoot, "src", "cli.ts"),
      "runner",
      "call",
      "judge",
      "--json",
      request,
      "--socket",
      args.runnerSocket,
    ],
    { cwd: home, env, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`runner judge refused ${args.taskId}: ${result.stderr.toString().trim()}`);
  return { task_id: args.taskId, card_id: packet.card.id, seat: args.seat, result: result.stdout.toString().trim() };
}
