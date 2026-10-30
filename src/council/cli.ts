/**
 * `ak council run`: ask the council one question outside a runner and write
 * down what each seat answered (ADR-0015).
 *
 * The two primary seats answer the same blind payload. When they agree to
 * approve, the blind veto seat answers that same payload. All three must
 * approve before the record says `approve`; any other result is `decline`
 * when the pair agreed not to approve, and otherwise one escalation. The
 * payload holds only the card and the context files the caller named, after
 * the outbound gate admits them.
 *
 * The record grants no authority. It is evidence an owner or a runner may
 * read; it approves no checkpoint, ticket, merge or deploy.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { DEFAULT_TIMEOUT_MS, readCouncilConfig, rosterProblems, type CouncilSeat } from "./config.ts";
import { checkOutbound, describeRefusals, outboundLimits, type OutboundItem } from "./outbound.ts";
import { councilOutcome, type CouncilResult } from "./rule.ts";
import { launchSeat, UNSPECIFIED, UNVERIFIED, type Attempt, type SeatResult, type Spawn } from "./seat.ts";

type Io = { out: (line: string) => void; err: (line: string) => void };

const USAGE =
  "usage: ak council run --card <card.json> --council-config <private roster> [--context <file>]... [--out <record.json>]";

interface CouncilCard {
  id: string;
  question: string;
  options: string[];
  approve: string;
}

const isCouncilCard = new Ajv2020({ strict: false }).compile<CouncilCard>({
  type: "object",
  additionalProperties: false,
  required: ["id", "question", "options", "approve"],
  properties: {
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
    question: { type: "string", minLength: 1 },
    options: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", minLength: 1 } },
    approve: { type: "string", minLength: 1 },
  },
});

interface SeatEntry {
  role: "primary" | "veto";
  seat: string;
  actor: string | null;
  model_requested: string;
  model_served: string;
  choice: string | null;
  rationale: string | null;
  attempts: Attempt[];
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function seatEntry(role: SeatEntry["role"], seat: CouncilSeat, result: SeatResult): SeatEntry {
  if (!result.ok)
    return {
      role,
      seat: seat.seat,
      actor: null,
      model_requested: seat.chain[0]?.model ?? UNSPECIFIED,
      model_served: UNVERIFIED,
      choice: null,
      rationale: null,
      attempts: result.attempts,
    };
  return {
    role,
    seat: seat.seat,
    actor: result.launcher.actor,
    model_requested: result.launcher.model ?? UNSPECIFIED,
    model_served: result.answer.model_served ?? UNVERIFIED,
    choice: result.answer.choice,
    rationale: result.answer.rationale,
    attempts: result.attempts,
  };
}

/** The council launchers' environment: the caller's, without any runner credential. */
function seatEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AK_RUNNER_")));
}

function spawner(cwd: string, timeoutMs: number): Spawn {
  return async (argv, stdin) => {
    const child = Bun.spawn(argv, { cwd, env: seatEnv(), stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
        child.exited,
      ]);
      if (timedOut) throw new Error(`launcher timed out after ${timeoutMs}ms`);
      return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
    } finally {
      clearTimeout(timer);
    }
  };
}

interface RunArgs {
  card: string;
  config: string;
  context: string[];
  out: string | undefined;
}

type Parsed = { ok: true; args: RunArgs } | { ok: false; error: string };

function parseArgs(argv: readonly string[]): Parsed {
  let card: string | undefined;
  let config: string | undefined;
  let out: string | undefined;
  const context: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${name ?? "flag"} needs a value` };
    if (name === "--card") card = value;
    else if (name === "--council-config") config = value;
    else if (name === "--context") context.push(value);
    else if (name === "--out") out = value;
    else return { ok: false, error: `unknown flag ${name ?? ""}` };
  }
  if (card === undefined || config === undefined)
    return { ok: false, error: "--card and --council-config are required" };
  return { ok: true, args: { card, config, context, out } };
}

async function run(args: RunArgs, io: Io): Promise<number> {
  const config = readCouncilConfig(args.config);
  const pair = config.pair;
  if (pair === undefined) throw new Error("a standalone council needs a pair in its council configuration");
  const problems = rosterProblems([...pair, config.veto]);
  if (problems.length > 0) throw new Error(`invalid council configuration: ${problems.join("; ")}`);
  const cardValue: unknown = JSON.parse(readFileSync(args.card, "utf8"));
  if (!isCouncilCard(cardValue)) throw new Error(`invalid card: ${JSON.stringify(isCouncilCard.errors)}`);
  const card = cardValue;
  if (!card.options.includes(card.approve)) throw new Error("the card's approving option is not one of its options");

  const context = args.context.map((path) => ({ path, name: basename(path), text: readFileSync(path, "utf8") }));
  const items: OutboundItem[] = [
    { label: "card", text: JSON.stringify(card) },
    ...context.map((entry) => ({ label: entry.name, path: entry.path, text: entry.text })),
  ];
  const refusals = checkOutbound(items, outboundLimits(config));
  const payload = JSON.stringify({
    council: "blind",
    card,
    context: context.map((entry) => ({ name: entry.name, sha256: sha256(entry.text), text: entry.text })),
  });
  const seats: SeatEntry[] = [];
  let decided: CouncilResult | null = null;
  if (refusals.length === 0) {
    const scratch = mkdtempSync(join(tmpdir(), "ak-council-"));
    try {
      const spawn = spawner(scratch, config.limits?.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      const results = await Promise.all(pair.map((seat) => launchSeat(seat, payload, card.options, spawn)));
      seats.push(...pair.map((seat, i) => seatEntry("primary", seat, results[i] ?? { ok: false, attempts: [] })));
      const choices = seats.map((entry) => entry.choice);
      let veto: string | null | undefined;
      if (choices.every((choice) => choice === card.approve)) {
        const result = await launchSeat(config.veto, payload, card.options, spawn);
        const entry = seatEntry("veto", config.veto, result);
        seats.push(entry);
        veto = entry.choice;
      }
      decided = councilOutcome(card.approve, choices, veto);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const record = {
    schema: "council-record",
    schema_version: 1,
    at: new Date().toISOString(),
    card,
    payload: {
      sha256: sha256(payload),
      bytes: Buffer.byteLength(payload, "utf8"),
      context: context.map((entry) => ({
        name: entry.name,
        sha256: sha256(entry.text),
        bytes: Buffer.byteLength(entry.text, "utf8"),
      })),
    },
    seats,
    outcome: decided?.outcome ?? "refused",
    choice: decided?.choice ?? null,
    causes: decided?.causes ?? describeRefusals(refusals),
    grants: [],
    note: "This record grants no authority. It approves no checkpoint, ticket, merge or deploy.",
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (args.out === undefined) io.out(text.trimEnd());
  else {
    writeFileSync(args.out, text, { mode: 0o600 });
    io.out(`council ${record.outcome}: ${args.out}`);
  }
  return record.outcome === "approve" || record.outcome === "decline" ? 0 : 1;
}

export async function runCouncil(argv: readonly string[], io: Io): Promise<number> {
  if (argv[0] !== "run") {
    io.err(USAGE);
    return 2;
  }
  const parsed = parseArgs(argv.slice(1));
  if (!parsed.ok) {
    io.err(`ak council: ${parsed.error}`);
    io.err(USAGE);
    return 2;
  }
  try {
    return await run(parsed.args, io);
  } catch (cause) {
    io.err(`ak council: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 2;
  }
}
