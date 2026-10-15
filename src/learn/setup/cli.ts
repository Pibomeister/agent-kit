/**
 * `ak learn setup` — install, check and remove the learning runtime's host wiring.
 * Every verb prints what it changed and is safe to re-run.
 * `--help` and `-h` print usage and exit before any verb runs. An unknown flag is a usage error.
 */
import { unknownSelector } from "../../util/suggest.ts";
import { flag, type LearnArea, type LearnContext } from "../core/context.ts";
import { doctor } from "./doctor.ts";
import { parseInterval, schedule } from "./schedule.ts";
import { scope } from "./scope.ts";
import { type SeedOptions, seed } from "./seed.ts";
import { uninstall } from "./uninstall.ts";
import { verify } from "./verify.ts";
import { defaultDeps, isWireHost, type SetupDeps, WIRE_HOSTS, wire } from "./wire.ts";

/** Flags each setup verb accepts. Value flags take the following argument; the rest are boolean. */
function flagSet(value: readonly string[], bool: readonly string[]) {
  return { value, bool };
}

const SETUP_FLAGS = {
  doctor: flagSet([], []),
  wire: flagSet(["host"], ["no-mem", "restart-worker"]),
  schedule: flagSet(["interval"], ["load"]),
  scope: flagSet(["set"], ["clear"]),
  seed: flagSet(["repo", "since"], ["no-github"]),
  verify: flagSet(["repo"], []),
  uninstall: flagSet([], ["purge"]),
};

/** An unknown verb accepts nothing, so a stray flag cannot fall through and write. */
function knownFlags(verb: string) {
  switch (verb) {
    case "doctor":
      return SETUP_FLAGS.doctor;
    case "wire":
      return SETUP_FLAGS.wire;
    case "schedule":
      return SETUP_FLAGS.schedule;
    case "scope":
      return SETUP_FLAGS.scope;
    case "seed":
      return SETUP_FLAGS.seed;
    case "verify":
      return SETUP_FLAGS.verify;
    case "uninstall":
      return SETUP_FLAGS.uninstall;
    default:
      return flagSet([], []);
  }
}

export interface SetupArgDecision {
  code: 0 | 2;
  /** Help is printed on stdout. A usage error is printed on stderr. */
  stream: "out" | "err";
  lines: readonly string[];
}

function isHelpToken(token: string): boolean {
  return token === "-h" || token === "--help";
}

/**
 * Help and unknown flags stop before configuration is read and before a verb writes.
 * `ak learn setup wire --help` prints usage and exits 0. An unknown flag is a usage error.
 * Null means the argv is one the verb already accepts.
 */
export function decideSetupArgs(verb: string, usage: string, argv: readonly string[]): SetupArgDecision | null {
  if (argv.some(isHelpToken)) return { code: 0, stream: "out", lines: [`ak learn ${usage}`] };
  const known = knownFlags(verb);
  const unexpected: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      unexpected.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (name === "") {
      unexpected.push(token);
      continue;
    }
    if (known.bool.includes(name)) continue;
    if (known.value.includes(name)) {
      if (eq === -1) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) i += 1;
      }
      continue;
    }
    unexpected.push(eq === -1 ? `--${name}` : token);
  }
  if (unexpected.length === 0) return null;
  return {
    code: 2,
    stream: "err",
    lines: [`ak learn setup ${verb}: unexpected ${unexpected.join(" ")}; usage: ak learn ${usage}`],
  };
}

/** The setup area bound to a dependency factory; tests pass one that never reaches the real machine. */
export function createSetupArea(depsFor: (ctx: LearnContext) => SetupDeps = defaultDeps): LearnArea {
  return {
    summary: "install and check the host wiring: hooks, scheduler, claude-mem mode, first seed",
    verbs: {
      doctor: {
        usage: "setup doctor                                  report prerequisites; changes nothing",
        run: (_args, ctx) => doctor(ctx, depsFor(ctx)),
      },
      wire: {
        usage: `setup wire [--host ${WIRE_HOSTS.join("|")}] [--no-mem] [--restart-worker]  merge hook entries and claude-mem settings`,
        run: (args, ctx) => {
          const host = flag(args, "host");
          if (host !== undefined && !isWireHost(host)) {
            ctx.io.err(`ak learn setup wire: --host: ${unknownSelector("host", host, WIRE_HOSTS)}`);
            return 2;
          }
          return wire(ctx, depsFor(ctx), {
            host,
            noMem: args.flags.has("no-mem"),
            restartWorker: args.flags.has("restart-worker"),
          });
        },
      },
      schedule: {
        usage: "setup schedule [--interval 15m] [--load]      write the scheduler unit for `ak learn memory tick`",
        run: (args, ctx) => {
          const intervalS = parseInterval(flag(args, "interval"));
          if (intervalS === null) {
            ctx.io.err("ak learn setup schedule: --interval is seconds, or Nm / Nh, and at least a minute");
            return 2;
          }
          return schedule(ctx, depsFor(ctx), { intervalS, load: args.flags.has("load") });
        },
      },
      scope: {
        usage: "setup scope [--set ROOT[:ROOT]] [--clear]   show or set the repos the hooks and the tick act on",
        run: (args, ctx) => {
          const set = flag(args, "set");
          if ((args.flags.has("set") && set === undefined) || (set !== undefined && args.flags.has("clear"))) {
            ctx.io.err("ak learn setup scope: --set takes ROOT[:ROOT], and --set and --clear are exclusive");
            return 2;
          }
          return scope(ctx, { set, clear: args.flags.has("clear") });
        },
      },
      seed: {
        usage:
          "setup seed --repo P [--since YYYY-MM-DD]      register a repo, create its ledgers, dry-run the first ingest",
        run: (args, ctx) => {
          const repo = flag(args, "repo");
          if (repo === undefined) {
            ctx.io.err("ak learn setup seed: --repo is required");
            return 2;
          }
          const since = flag(args, "since");
          const options: SeedOptions = {};
          if (since !== undefined) options.since = since;
          options.skipGithub = args.flags.has("no-github");
          return seed(ctx, repo, options);
        },
      },
      verify: {
        usage: "setup verify [--repo P]                       check wiring, scheduler unit, ledgers and judge",
        run: (args, ctx) => verify(ctx, depsFor(ctx), flag(args, "repo")),
      },
      uninstall: {
        usage: "setup uninstall [--purge]                     remove hooks and the unit; ledgers kept unless --purge",
        run: (args, ctx) => uninstall(ctx, depsFor(ctx), { purge: args.flags.has("purge") }),
      },
    },
  };
}

export const setupArea: LearnArea = createSetupArea();
