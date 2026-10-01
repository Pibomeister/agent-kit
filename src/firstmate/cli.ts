/**
 * `ak firstmate …`. A separate parser from the top-level one because every flag
 * here takes a value and the set differs per subcommand; an unknown flag is an
 * error, never ignored.
 *
 * The package root is where this file lives, not the working directory: a
 * patched Firstmate calls `ak firstmate bind` from its own home.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { auditRun } from "./audit.ts";
import { bind } from "./bind.ts";
import {
  defaultLedgerDir,
  defaultPinsDir,
  defaultUpstream,
  HOSTS,
  type Evidence,
  type FirstmateOptions,
  type Host,
} from "./constants.ts";
import { evidenceFromEnv, readHomeEnv } from "./envfile.ts";
import { grant } from "./grant.ts";
import { install, remove } from "./install.ts";
import { preflight } from "./preflight.ts";
import { validateBinding, type Binding } from "./schema.ts";
import { OUTCOMES, statusLine, type Outcome } from "./status.ts";
import { preflightStock, stockBrief } from "./stock.ts";
import { judgeSeat, launchSeat } from "./seat.ts";

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const FIRSTMATE_USAGE = [
  "ak firstmate — use agent-kit with stock Firstmate briefs and delivery modes",
  "",
  "  ak firstmate preflight --fm-home <dir> --project <dir> [--host claude-code|codex]",
  "                         [--runner-socket <path>] [--json]",
  "  ak firstmate brief --run <id> --charter <file> --runner-socket <path>",
  "                     --worker-token <token> --delivery no-mistakes|direct-PR|local-only",
  "  ak firstmate seat-launch --fm-home <home> --task-id <id> --project-name <name>",
  "                            --project-dir <dir> --packet <file> --evidence-dir <dir>",
  "                            --captain-intent-file <file> --implementer-worktree <dir> [--harness <host>]",
  "  ak firstmate seat-judge --fm-home <home> --task-id <id> --packet <file>",
  "                           --seat <id> --actor <id> --runner-socket <path> --admin-token-file <file>",
  "  Legacy patched-home commands (optional): preflight --legacy-patched, bind, install, remove, grant, status",
  "  ak firstmate bind --fm-home <dir> --task-id <id> --project <dir> --mode agent-kit",
  "                    --binding-out <file> [--host …] [--evidence … --evidence-location …]",
  "                    [--charter <file>] [--dry-run]",
  "  ak firstmate install --fm-home <dir> [--evidence mock --evidence-location <dir>]",
  "  ak firstmate remove --fm-home <dir>",
  "  ak firstmate status <binding.json> complete|needs-input|cap-reached|failed|cancelled",
  "                      [--pr <url>] [--evidence <id,id>] [--reason <text>] [--open-findings <id,id>]",
  "                      [--by <who>] [--unknown-child <id>] [--at <epoch>] [--project <dir>]",
  "  ak firstmate status <binding.json> --verify [--project <dir>]",
  "                      audit the run: a current gate record per required gate, grants that match the ledger",
  "  ak firstmate grant --binding <file> --operation review.full|review.readiness|ship.prepare [--cwd <dir>]",
  "",
  "Seat launch uses stock Firstmate task commands; no command applies the legacy patches. See adapters/firstmate/CONTRACT.md.",
];

const BOOL = new Set(["json", "dry-run", "verify", "legacy-patched"]);
const ALLOWED: Record<string, readonly string[]> = {
  preflight: [
    "fm-home",
    "project",
    "host",
    "runner-socket",
    "legacy-patched",
    "evidence",
    "evidence-location",
    "bundle-dir",
    "pins-dir",
    "json",
  ],
  brief: ["run", "charter", "runner-socket", "worker-token", "delivery"],
  "seat-launch": [
    "fm-home",
    "task-id",
    "project-name",
    "project-dir",
    "packet",
    "evidence-dir",
    "captain-intent-file",
    "implementer-worktree",
    "harness",
  ],
  "seat-judge": ["fm-home", "task-id", "packet", "seat", "actor", "runner-socket", "admin-token-file"],
  bind: [
    "fm-home",
    "task-id",
    "project",
    "mode",
    "binding-out",
    "host",
    "evidence",
    "evidence-location",
    "charter",
    "dry-run",
    "bundle-dir",
    "pins-dir",
    "json",
  ],
  install: ["fm-home", "evidence", "evidence-location"],
  remove: ["fm-home"],
  status: ["pr", "evidence", "reason", "open-findings", "by", "unknown-child", "at", "verify", "project"],
  grant: ["binding", "operation", "cwd"],
};

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
  problems: string[];
}

function parseArgs(sub: string, argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const problems: string[] = [];
  const allowed = new Set(ALLOWED[sub] ?? []);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
    if (!allowed.has(name)) {
      problems.push(`unknown flag --${name} for ak firstmate ${sub}`);
      continue;
    }
    if (BOOL.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = inline ?? argv[i + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      problems.push(`--${name} needs a value`);
      continue;
    }
    if (inline === undefined) i += 1;
    flags.set(name, value);
  }
  return { positional, flags, problems };
}

const str = (a: Args, name: string): string | undefined => {
  const v = a.flags.get(name);
  return typeof v === "string" ? v : undefined;
};

function options(a: Args, host: Host, ledgerDir: string): FirstmateOptions {
  const akRoot = resolve(import.meta.dir, "..", "..");
  return {
    akRoot,
    bundleDir: resolve(str(a, "bundle-dir") ?? join(akRoot, "dist", host)),
    pinsDir: resolve(str(a, "pins-dir") ?? defaultPinsDir()),
    ledgerDir,
    upstream: defaultUpstream(akRoot),
    now: () => new Date(),
  };
}

function hostOf(a: Args): { host: Host } | { error: string } {
  const h = str(a, "host") ?? "claude-code";
  return (HOSTS as readonly string[]).includes(h)
    ? { host: h as Host }
    : { error: `--host must be one of ${HOSTS.join(", ")}` };
}

function evidenceOf(a: Args): { evidence: Evidence | undefined } | { error: string } {
  const store = str(a, "evidence");
  const location = str(a, "evidence-location");
  if (store === undefined && location === undefined) return { evidence: undefined };
  if (store !== "kb" && store !== "mock") return { error: "--evidence must be kb or mock" };
  if (location === undefined) return { error: "--evidence needs --evidence-location" };
  return { evidence: { store, location: store === "mock" ? resolve(location) : location } };
}

function need(a: Args, names: string[], io: Io, sub: string): boolean {
  const missing = names.filter((n) => str(a, n) === undefined);
  for (const n of missing) io.err(`ak firstmate ${sub}: --${n} is required`);
  return missing.length === 0;
}

export function runFirstmate(argv: readonly string[], io: Io, ledgerDir: string = defaultLedgerDir()): number {
  const sub = argv[0];
  if (sub === undefined || !(sub in ALLOWED)) {
    if (sub !== undefined) io.err(`ak firstmate: unknown subcommand ${sub}`);
    for (const line of FIRSTMATE_USAGE) io.err(line);
    return 2;
  }
  const a = parseArgs(sub, argv.slice(1));
  if (a.problems.length > 0) {
    for (const p of a.problems) io.err(`ak firstmate: ${p}`);
    return 2;
  }
  const hosted = hostOf(a);
  if ("error" in hosted) {
    io.err(`ak firstmate: ${hosted.error}`);
    return 2;
  }
  const host = hosted.host;
  // On status, --evidence is a list of evidence refs, not a store.
  const stored = sub === "status" ? { evidence: undefined } : evidenceOf(a);
  if ("error" in stored) {
    io.err(`ak firstmate: ${stored.error}`);
    return 2;
  }
  const evidence = stored.evidence;
  const opts = options(a, host, ledgerDir);

  switch (sub) {
    case "preflight": {
      if (!need(a, ["fm-home", "project"], io, sub)) return 2;
      const fmHome = resolve(str(a, "fm-home")!);
      const project = resolve(str(a, "project")!);
      const result =
        a.flags.get("legacy-patched") === true
          ? preflight({ fmHome, project, host, evidence: evidence ?? evidenceFromEnv(readHomeEnv(fmHome)) }, opts)
          : preflightStock(fmHome, project, host, opts.akRoot, opts.bundleDir, str(a, "runner-socket"));
      if (a.flags.get("json") === true) io.out(JSON.stringify(result, null, 2));
      else for (const c of result.checks) io.out(`${c.ok ? "ok  " : "FAIL"}  ${c.id.padEnd(20)} ${c.detail}`);
      return result.ok ? 0 : 1;
    }
    case "brief": {
      if (!need(a, ["run", "charter", "runner-socket", "worker-token", "delivery"], io, sub)) return 2;
      const delivery = str(a, "delivery");
      if (delivery !== "no-mistakes" && delivery !== "direct-PR" && delivery !== "local-only") {
        io.err("ak firstmate brief: --delivery must be a stock Firstmate mode");
        return 2;
      }
      const run = str(a, "run");
      const charter = str(a, "charter");
      const socket = str(a, "runner-socket");
      const workerToken = str(a, "worker-token");
      if (run === undefined || charter === undefined || socket === undefined || workerToken === undefined) return 2;
      try {
        io.out(stockBrief({ run, charter, socket, workerToken, delivery }));
        return 0;
      } catch (cause) {
        io.err(`ak firstmate brief: ${cause instanceof Error ? cause.message : String(cause)}`);
        return 1;
      }
    }
    case "seat-launch": {
      if (
        !need(
          a,
          [
            "fm-home",
            "task-id",
            "project-name",
            "project-dir",
            "packet",
            "evidence-dir",
            "captain-intent-file",
            "implementer-worktree",
          ],
          io,
          sub,
        )
      )
        return 2;
      try {
        const result = launchSeat({
          fmHome: str(a, "fm-home") ?? "",
          taskId: str(a, "task-id") ?? "",
          projectName: str(a, "project-name") ?? "",
          projectDir: str(a, "project-dir") ?? "",
          packetPath: str(a, "packet") ?? "",
          evidenceDir: str(a, "evidence-dir") ?? "",
          captainIntentFile: str(a, "captain-intent-file") ?? "",
          implementerWorktree: str(a, "implementer-worktree") ?? "",
          harness: str(a, "harness"),
        });
        io.out(JSON.stringify(result, null, 2));
        return 0;
      } catch (cause) {
        io.err(`ak firstmate seat-launch: ${cause instanceof Error ? cause.message : String(cause)}`);
        return 1;
      }
    }
    case "seat-judge": {
      if (!need(a, ["fm-home", "task-id", "packet", "seat", "actor", "runner-socket", "admin-token-file"], io, sub))
        return 2;
      try {
        const result = judgeSeat({
          fmHome: str(a, "fm-home") ?? "",
          taskId: str(a, "task-id") ?? "",
          packetPath: str(a, "packet") ?? "",
          seat: str(a, "seat") ?? "",
          actor: str(a, "actor") ?? "",
          runnerSocket: str(a, "runner-socket") ?? "",
          adminTokenFile: str(a, "admin-token-file") ?? "",
          akRoot: opts.akRoot,
        });
        io.out(JSON.stringify(result, null, 2));
        return 0;
      } catch (cause) {
        io.err(`ak firstmate seat-judge: ${cause instanceof Error ? cause.message : String(cause)}`);
        return 1;
      }
    }
    case "bind": {
      if (!need(a, ["fm-home", "task-id", "project", "mode", "binding-out"], io, sub)) return 2;
      const result = bind(
        {
          fmHome: resolve(str(a, "fm-home")!),
          taskId: str(a, "task-id")!,
          project: resolve(str(a, "project")!),
          mode: str(a, "mode")!,
          bindingOut: resolve(str(a, "binding-out")!),
          host,
          evidence,
          charter: str(a, "charter"),
          dryRun: a.flags.get("dry-run") === true,
        },
        opts,
      );
      if (!result.ok) {
        for (const e of result.errors) io.err(`ak firstmate bind: ${e}`);
        return 1;
      }
      if (a.flags.get("json") === true) io.out(JSON.stringify(result.binding, null, 2));
      else io.out(result.markdown.replace(/\n+$/, ""));
      return 0;
    }
    case "install":
    case "remove": {
      if (!need(a, ["fm-home"], io, sub)) return 2;
      const result =
        sub === "install"
          ? install({ fmHome: str(a, "fm-home")!, evidence }, opts)
          : remove({ fmHome: str(a, "fm-home")! }, opts);
      for (const e of result.errors) io.err(`ak firstmate ${sub}: ${e}`);
      for (const w of result.written) io.out(`wrote ${w}`);
      if (result.ok && sub === "remove") io.out("removed agent-kit configuration");
      return result.ok ? 0 : 1;
    }
    case "status": {
      const [file, outcome] = a.positional;
      const verifyOnly = a.flags.get("verify") === true;
      if (
        file === undefined ||
        (verifyOnly
          ? outcome !== undefined
          : outcome === undefined || !(OUTCOMES as readonly string[]).includes(outcome))
      ) {
        io.err(
          `ak firstmate status: needs <binding.json> and one of ${OUTCOMES.join(", ")}, or <binding.json> --verify`,
        );
        return 2;
      }
      if (!existsSync(file)) {
        io.err(`ak firstmate status: ${file} does not exist`);
        return 1;
      }
      let binding: unknown;
      try {
        binding = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        io.err(`ak firstmate status: ${file} is not JSON: ${(e as Error).message}`);
        return 1;
      }
      const invalid = validateBinding(opts.akRoot, binding);
      if (invalid.length > 0) {
        for (const e of invalid) io.err(`ak firstmate status: binding does not validate: ${e}`);
        return 1;
      }
      const b = binding as Binding;
      // Done is checked, not taken on the worker's word: the same audit Firstmate runs with --verify.
      if (verifyOnly || outcome === "complete") {
        const project = str(a, "project");
        const refusals = auditRun({
          binding: b,
          bindingPath: file,
          ledgerDir: opts.ledgerDir,
          project: project === undefined ? undefined : resolve(project),
        });
        for (const r of refusals) io.err(`ak firstmate status: ${r}`);
        if (refusals.length > 0) {
          io.err(
            `needs-decision: this run is not done. Run the missing phases through the lifecycle, or report ak firstmate status ${file} needs-input --reason "<which gate and why>"`,
          );
          return 1;
        }
        if (verifyOnly) {
          io.out(
            `verified: run ${b.run_id} has a current record for ${b.required_gates.join(", ")} and every grant matches the ledger`,
          );
          return 0;
        }
      }
      const list = (name: string) =>
        str(a, name)
          ?.split(",")
          .filter((s) => s !== "");
      const at = str(a, "at");
      if (at !== undefined && !/^\d+$/.test(at)) {
        io.err("ak firstmate status: --at must be an epoch in seconds");
        return 2;
      }
      const result = statusLine(b, {
        outcome: outcome as Outcome,
        at: at === undefined ? Math.floor(Date.now() / 1000) : Number(at),
        pr: str(a, "pr"),
        evidence: list("evidence"),
        reason: str(a, "reason"),
        run: b.run_id,
        openFindings: list("open-findings"),
        by: str(a, "by"),
        unknownChild: str(a, "unknown-child"),
      });
      if (!result.ok) {
        io.err(`ak firstmate status: ${result.error}`);
        return 1;
      }
      io.out(result.line);
      return 0;
    }
    case "grant": {
      if (!need(a, ["binding", "operation"], io, sub)) return 2;
      const binding = resolve(str(a, "binding")!);
      const operation = str(a, "operation")!;
      const result = grant(
        { binding, operation, cwd: resolve(str(a, "cwd") ?? process.cwd()) },
        opts.akRoot,
        opts.ledgerDir,
      );
      if (!result.ok) {
        io.err(`ak firstmate grant: refused: ${result.reason}`);
        io.err(
          `needs-decision: stop before ${operation} and report it to Firstmate, e.g. ak firstmate status ${binding} needs-input --reason "${operation} not granted by the binding"`,
        );
        return 1;
      }
      io.out(JSON.stringify(result.record, null, 2));
      return 0;
    }
  }
  return 2;
}
