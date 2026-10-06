/**
 * `ak kb` — the knowledgebase adapter's operations for one bound project
 * (adapters/knowledgebase/CONTRACT.md §7).
 *
 * `read` and `publish` print one JSON result on stdout, because the caller is a
 * skill binding evidence to it. The exit status says which of four things
 * happened, and a caller needs to tell them apart: 0 the operation completed,
 * 1 it failed or was refused, 2 the command line was wrong, 3 no knowledgebase
 * is configured for this checkout on this machine.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { formatIssue, sortIssues } from "../validation/types.ts";
import {
  BINDING_FILE,
  findKbProjectRoot,
  registerKnowledgebase,
  registryPath,
  resolveKnowledgebase,
  type KbResolution,
  type ResolvedKb,
} from "./binding.ts";
import {
  KB_KINDS,
  publishDocument,
  publishRunArtifact,
  readContext,
  type KbRefusal,
  type PublishOutcome,
  type ReadOutcome,
} from "./local-git.ts";

export interface KbIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface KbOptions {
  cwd: string;
  io: KbIo;
  /** The operator's registry file; defaults to the account's (`registryPath`). */
  registry?: string;
}

export const EXIT_UNAVAILABLE = 3;

/** Why an operation that needs a knowledgebase did not reach one. */
interface UnresolvedResult {
  status: "unavailable" | "refused" | "failed";
  capability: "kb-read" | "kb-write";
  knowledgebase: "unavailable" | "failed";
  code: string;
  message: string;
}

/** The refusal of one of the five operations no backend carries. */
interface NotCarriedResult extends KbRefusal {
  operation: string;
}

type KbResult = ReadOutcome | PublishOutcome | KbRefusal | UnresolvedResult | NotCarriedResult;

const USAGE = [
  "ak kb — reach the project's central knowledgebase (ak.kb.yaml)",
  "",
  "  ak kb check [<project-dir>]",
  "      the binding, the registration and whether the two operations can run",
  "  ak kb read --kind <kind>[,<kind>…] --scope <scope> [--dir <project-dir>]",
  "      readContext: committed pages at the scope and above it, most specific first",
  "  ak kb publish document --kind <kind> --scope <scope> --id <id> --title <title> --file <page.md> [--run <run-id>]",
  "      publishArtifact, kb-document placement; an adr is stored proposed",
  "  ak kb publish artifact --file <artifact.json> --run <run-id> [--link <record-ref>]…",
  "      publishArtifact, run-artifact placement; validated against its schema first",
  "  ak kb register <knowledgebase-id> <path>",
  "      the operator's step, once per machine: where that knowledgebase is checked out",
  "",
  `  kinds: ${KB_KINDS.join(", ")}`,
  "  scope: a component as kebab-case words joined by '/', or 'project' for the whole project",
  "",
  "Exit 0 complete, 1 failed or refused, 2 usage, 3 no knowledgebase configured.",
];

/** The five operations no backend here carries, by the command a caller might reach for. */
const NOT_CARRIED = new Map([
  ["record-decision", "recordDecision"],
  ["link-code-evidence", "linkCodeEvidence"],
  ["request-impact-analysis", "requestImpactAnalysis"],
  ["link-pull-requests", "linkPullRequests"],
  ["propose-lesson", "proposeLesson"],
]);

const VALUE_FLAGS = new Set(["kind", "scope", "id", "title", "file", "run", "dir"]);

interface KbArgs {
  positional: string[];
  values: Map<string, string>;
  links: string[];
  /** The first token that is not a flag this command takes, or a flag with no value. */
  bad: string | null;
}

function parseArgs(argv: readonly string[]): KbArgs {
  const args: KbArgs = { positional: [], values: new Map(), links: [], bad: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) {
      args.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = argv[i + 1];
    if ((!VALUE_FLAGS.has(name) && name !== "link") || value === undefined) {
      args.bad ??= token;
      continue;
    }
    if (name === "link") args.links.push(value);
    else args.values.set(name, value);
    i += 1;
  }
  return args;
}

function usage(io: KbIo, message: string): number {
  io.err(`ak kb: ${message}`);
  for (const line of USAGE) io.err(line);
  return 2;
}

/** Every result is one JSON document on stdout, so a caller parses the whole of it. */
function printResult(io: KbIo, result: KbResult): void {
  io.out(JSON.stringify(result, null, 2));
}

/** The project folder a command works on: `--dir`, a positional, or where it was run. */
function projectDir(options: KbOptions, dir: string | undefined): string | null {
  const start = dir === undefined ? options.cwd : isAbsolute(dir) ? dir : join(options.cwd, dir);
  return existsSync(start) && statSync(start).isDirectory() ? findKbProjectRoot(start) : null;
}

/**
 * Print why no knowledgebase resolved, as the result of the operation that
 * needed one, and return its exit status. A read with nothing configured is
 * `unavailable` and the run continues past it; a write is a refusal
 * (CONTRACT.md §1). A knowledgebase that is configured and unusable is
 * `failed` either way.
 */
function reportUnresolved(io: KbIo, capability: "kb-read" | "kb-write", resolution: KbResolution): number {
  const issue = resolution.issues[0];
  const unavailable = resolution.state === "unavailable";
  printResult(io, {
    status: unavailable ? (capability === "kb-read" ? "unavailable" : "refused") : "failed",
    capability,
    knowledgebase: unavailable ? "unavailable" : "failed",
    code: issue?.rule ?? "kb.unresolved",
    message: issue?.message ?? "No knowledgebase resolved.",
  });
  return unavailable ? EXIT_UNAVAILABLE : 1;
}

function check(options: KbOptions, args: KbArgs): number {
  const dir = args.positional[1] ?? args.values.get("dir");
  const root = projectDir(options, dir);
  if (root === null) {
    options.io.out(
      `ERROR  kb.project-missing  ${dir ?? "."}: Not a directory, so there is no project folder to check.`,
    );
    return 1;
  }
  const resolution = resolveKnowledgebase(root, options.registry ?? registryPath());
  for (const issue of sortIssues(resolution.issues)) options.io.out(formatIssue(issue));
  if (resolution.resolved !== null) {
    const kb = resolution.resolved;
    options.io.out(
      `ak kb check: bound. ${BINDING_FILE} names backend ${kb.binding.backend}, knowledgebase '${kb.knowledgebase}' at ${kb.root}, project '${kb.binding.project}'. readContext and publishArtifact are carried; the other five operations refuse.`,
    );
    return 0;
  }
  const words =
    resolution.state === "unavailable" ? "no knowledgebase configured" : "the configured knowledgebase cannot be used";
  options.io.out(
    `ak kb check: ${words}. kb-read returns ${resolution.state === "unavailable" ? "unavailable" : "failed"} and kb-write refuses.`,
  );
  return resolution.state === "unavailable" ? EXIT_UNAVAILABLE : 1;
}

function resolveFor(options: KbOptions, args: KbArgs): KbResolution | null {
  const root = projectDir(options, args.values.get("dir"));
  return root === null ? null : resolveKnowledgebase(root, options.registry ?? registryPath());
}

function finish(io: KbIo, outcome: ReadOutcome | PublishOutcome | KbRefusal): number {
  printResult(io, outcome);
  return outcome.status === "complete" ? 0 : 1;
}

function read(options: KbOptions, args: KbArgs): number {
  const kinds = args.values.get("kind");
  const scope = args.values.get("scope");
  if (kinds === undefined || scope === undefined) return usage(options.io, "read needs --kind and --scope");
  const resolution = resolveFor(options, args);
  if (resolution === null) return usage(options.io, "--dir is not a directory");
  if (resolution.resolved === null) return reportUnresolved(options.io, "kb-read", resolution);
  return finish(options.io, readContext(resolution.resolved, kinds.split(","), scope));
}

function readFile(options: KbOptions, path: string): string | null {
  const file = isAbsolute(path) ? path : join(options.cwd, path);
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function publishOne(options: KbOptions, args: KbArgs, kb: ResolvedKb, text: string): number {
  const run = args.values.get("run");
  if (args.positional[1] === "artifact") {
    if (run === undefined) return usage(options.io, "publish artifact needs --run");
    return finish(options.io, publishRunArtifact(kb, text, run, args.links));
  }
  const kind = args.values.get("kind");
  const scope = args.values.get("scope");
  const id = args.values.get("id");
  const title = args.values.get("title");
  if (kind === undefined || scope === undefined || id === undefined || title === undefined) {
    return usage(options.io, "publish document needs --kind, --scope, --id and --title");
  }
  if (args.links.length > 0) return usage(options.io, "--link belongs to publish artifact");
  return finish(options.io, publishDocument(kb, { kind, scope, id, title, body: text, run: run ?? null }));
}

function publish(options: KbOptions, args: KbArgs): number {
  const placement = args.positional[1];
  if (placement !== "document" && placement !== "artifact") {
    return usage(options.io, "publish needs a placement: document or artifact");
  }
  const path = args.values.get("file");
  if (path === undefined) return usage(options.io, "publish needs --file");
  const resolution = resolveFor(options, args);
  if (resolution === null) return usage(options.io, "--dir is not a directory");
  if (resolution.resolved === null) return reportUnresolved(options.io, "kb-write", resolution);
  const text = readFile(options, path);
  if (text === null) {
    printResult(options.io, { status: "refused", code: "kb.file-unreadable", message: `${path} could not be read.` });
    return 1;
  }
  return publishOne(options, args, resolution.resolved, text);
}

function register(options: KbOptions, args: KbArgs): number {
  const id = args.positional[1];
  const path = args.positional[2];
  if (id === undefined || path === undefined || args.positional.length !== 3) {
    return usage(options.io, "register needs a knowledgebase id and the path of its checkout");
  }
  const file = options.registry ?? registryPath();
  const issues = registerKnowledgebase(file, id, path, options.cwd);
  for (const issue of issues) options.io.out(formatIssue(issue));
  if (issues.length > 0) return 1;
  options.io.out(`ak kb register: knowledgebase '${id}' is registered in ${file}.`);
  return 0;
}

export function kbUsage(): readonly string[] {
  return USAGE;
}

export function runKb(argv: readonly string[], options: KbOptions): number {
  const args = parseArgs(argv);
  const command = args.positional[0];
  if (command === undefined || command === "help") {
    for (const line of USAGE) options.io.out(line);
    return command === undefined ? 2 : 0;
  }
  const operation = NOT_CARRIED.get(command);
  if (operation !== undefined) {
    printResult(options.io, {
      status: "refused",
      code: "kb.operation-not-carried",
      operation,
      message: `No knowledgebase backend in this package carries ${operation}. It is refused and nothing was written; readContext and publishArtifact are the two operations carried (adapters/knowledgebase/CONTRACT.md §7).`,
    });
    return 1;
  }
  if (args.bad !== null) return usage(options.io, `${args.bad} is not a flag this command takes, or has no value`);
  switch (command) {
    case "check":
      return check(options, args);
    case "read":
      return read(options, args);
    case "publish":
      return publish(options, args);
    case "register":
      return register(options, args);
    default:
      return usage(options.io, `unknown subcommand ${command}`);
  }
}
