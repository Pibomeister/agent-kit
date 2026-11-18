/**
 * The unattended lifecycle policy (docs/decisions/0014-unattended-lifecycle-policy.md and its amendment of
 * 2026-11-11): selection, and the declared run supervisor ship rests on.
 *
 * A runner opts in through `AK_LIFECYCLE_POLICY=unattended` or `ak.lifecycle.json` on the default branch.
 * Phases then start with no typed command or grant, and the trust boundary is a supervisor that declares, in
 * a file outside the checkout, how it meets six obligations. This module holds the policy resolution, the
 * disclosure sentence and the shape rules of the two supervisor files: the declaration the run is stamped
 * with and the attestation final ship takes. It reads no forge and spawns nothing but local git. The gate
 * (`gate.ts`) holds containment, readability, head ancestry and the ship sequence.
 *
 * Bundled into `bin/ak-gate.mjs` with `gate.ts`, so it imports only `node:` built-ins.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const POLICY_ENV = "AK_LIFECYCLE_POLICY";
export const SUPERVISOR_ENV = "AK_LIFECYCLE_SUPERVISOR";
export const SUPERVISOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DECLARATION_ENV = "AK_LIFECYCLE_SUPERVISOR_DECLARATION";
export const CONFIG_FILE = "ak.lifecycle.json";
export const UNATTENDED = "unattended";
/** The version of the supervisor contract both files name (adapters/supervisor/CONTRACT.md). */
export const CONTRACT = "agent-kit/supervisor-contract@1";
export const OBLIGATIONS = [
  "launch-and-watch",
  "validation-gate",
  "independent-review",
  "seat-separation",
  "head-bound-evidence",
  "disclosure",
] as const;
export type Obligation = (typeof OBLIGATIONS)[number];
export const HUMAN_STARTED_PHASES = ["super-align", "super-bound", "super-ship"] as const;
export const MODEL_STARTED_PHASES = ["super-scout", "super-build", "super-verify", "super-review"] as const;

/** The sentence a pull request carries when the supervisor stands in place of a human. */
export function unattendedDisclosure(supervisor: string): string {
  return `Unattended lifecycle policy (supervisor: ${supervisor}, in place of a human): no human approved the align or bound artifacts, phase evidence is worker-attested and kept in the runner's evidence store, the supervisor attests its validation gate and independent review at the head, which agent-kit checks but cannot authenticate, and agent-kit does not merge: whoever the human authorized merges.`;
}

export interface Policy {
  name: typeof UNATTENDED;
  /** `environment`, or `default-branch:<revision>` the configuration was read at. */
  source: string;
  /** `AK_LIFECYCLE_SUPERVISOR`, when set: the supervisor recorded in place of a human. */
  supervisor?: string;
}

/** A parsed JSON value. */
export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

const kind = (v: Json | undefined) => Object.prototype.toString.call(v);
const isText = (v: Json | undefined): v is string => kind(v) === "[object String]";
const isObject = (v: Json | undefined): v is JsonObject => kind(v) === "[object Object]";
/** JSON.parse yields only JSON values; this names that for the type system, one level deep. */
const JSON_KINDS = new Set(["Null", "Boolean", "Number", "String", "Array", "Object"].map((k) => `[object ${k}]`));
const isJson = (value: unknown): value is Json => JSON_KINDS.has(Object.prototype.toString.call(value));
const field = (v: Json | undefined, key: string): Json | undefined => (isObject(v) ? v[key] : undefined);
export const parseJson = (source: string): Json | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  return isJson(value) ? value : undefined;
};

/** `sha256:` and 64 lower-case hex digits over the bytes. */
export const sha256Digest = (bytes: Uint8Array | string): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const exec = (cmd: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
};

/**
 * The active policy: the environment first, else the default-branch configuration at the local
 * `refs/remotes/origin/HEAD`, never the working tree or the task branch. Undefined is the legacy policy.
 * Only the configuration's `policy` key is read; any other key is ignored. `gitOptions` go before each git
 * subcommand: final ship passes its guard there, and a read that fails under it is the legacy policy.
 * `gitEnv`, when set, is the environment those git reads run in, so final ship can drop redirecting variables.
 */
export function resolvePolicy(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
  gitOptions: readonly string[] = [],
  gitEnv?: NodeJS.ProcessEnv,
): { ok: true; policy?: Policy } | { ok: false; reason: string } {
  const supervisor = env[SUPERVISOR_ENV];
  if (supervisor !== undefined && !SUPERVISOR_PATTERN.test(supervisor))
    return { ok: false, reason: `${SUPERVISOR_ENV} must match ${SUPERVISOR_PATTERN.source}` };
  const stamp = (source: string): Policy =>
    supervisor === undefined ? { name: UNATTENDED, source } : { name: UNATTENDED, source, supervisor };
  const value = env[POLICY_ENV];
  if (value !== undefined && value !== "") {
    if (value !== UNATTENDED)
      return { ok: false, reason: `${POLICY_ENV} accepts only '${UNATTENDED}', not '${value}'` };
    return { ok: true, policy: stamp("environment") };
  }
  const rev = exec(
    "git",
    [...gitOptions, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"],
    project,
    gitEnv,
  );
  const revision = rev.out.trim();
  if (rev.code !== 0 || revision === "") return { ok: true };
  const file = exec("git", [...gitOptions, "show", `${revision}:${CONFIG_FILE}`], project, gitEnv);
  if (file.code !== 0 || field(parseJson(file.out), "policy") !== UNATTENDED) return { ok: true };
  return { ok: true, policy: stamp(`default-branch:${revision}`) };
}

// ── the two supervisor files ─────────────────────────────────────────────────

/** A non-empty string on one line. The schemas carry the same pattern. */
const SINGLE_LINE = /^[^\r\n\u2028\u2029]*\S[^\r\n\u2028\u2029]*$/;
/** One provider segment, a slash, a remainder; no whitespace and no upper-case letter. The attestation schema carries the same pattern. */
const IDENTITY = new RegExp("^[^\\s/\\p{Lu}\\p{Lt}]+/[^\\s\\p{Lu}\\p{Lt}]+$", "u");
const HEAD = /^[0-9a-f]{40}$/;

const singleLine = (v: Json | undefined): v is string => isText(v) && SINGLE_LINE.test(v);
const shown = (v: Json | undefined): string => JSON.stringify(v) ?? "undefined";

/** Lower-case, no surrounding whitespace, one provider segment, a slash and a remainder with no whitespace. */
export function isCanonicalIdentity(id: string): boolean {
  return IDENTITY.test(id);
}

export interface Declaration {
  contract: string;
  supervisor: string;
  obligations: Record<Obligation, string>;
}

const unknownKeys = (where: string, value: JsonObject, allowed: readonly string[]): string[] =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where} has unknown key ${JSON.stringify(key)}`);

/** The shape of a declaration and its name equality; an empty list means valid. Each message names the failed key. */
export function declarationFailures(value: Json | undefined, supervisor: string): string[] {
  if (!isObject(value)) return ["declaration must be a JSON object"];
  const failures = unknownKeys("declaration", value, ["contract", "supervisor", "obligations"]);
  if (value.contract !== CONTRACT)
    failures.push(`contract must be ${JSON.stringify(CONTRACT)}, not ${shown(value.contract)}`);
  const named = value.supervisor;
  if (!isText(named) || !SUPERVISOR_PATTERN.test(named))
    failures.push(`supervisor must match ${SUPERVISOR_PATTERN.source}`);
  else if (named !== supervisor)
    failures.push(
      `supervisor ${JSON.stringify(named)} differs from the supervisor named by ${SUPERVISOR_ENV} (${JSON.stringify(supervisor)})`,
    );
  const obligations = value.obligations;
  if (!isObject(obligations)) failures.push("obligations must be a JSON object");
  else {
    failures.push(...unknownKeys("obligations", obligations, OBLIGATIONS));
    for (const key of OBLIGATIONS) {
      if (!(key in obligations)) failures.push(`obligations.${key} is missing`);
      else if (!singleLine(obligations[key]))
        failures.push(`obligations.${key} must be a non-empty single-line string`);
    }
  }
  return failures;
}

export interface Attestation {
  contract: string;
  supervisor: string;
  head: string;
  pull_request?: string;
  validation: { result: "pass"; ref: string };
  review: { result: "approve"; reviewer: string; authors: string[]; ref: string };
}

const identityFailure = (where: string, id: Json | undefined): string[] =>
  isText(id) && isCanonicalIdentity(id)
    ? []
    : [`${where} ${shown(id)} is not a canonical provider/model identity (lower-case, no whitespace, provider/model)`];

/**
 * One walk over an attestation: the shape and the supervisor equality, with keys closed at every level, and the typed
 * attestation built from the same values. Each value is copied only once it passes its check.
 */
export function readAttestation(
  value: Json | undefined,
  supervisor: string,
): { ok: true; attestation: Attestation } | { ok: false; failures: string[] } {
  if (!isObject(value)) return { ok: false, failures: ["attestation must be a JSON object"] };
  const failures = unknownKeys("attestation", value, [
    "contract",
    "supervisor",
    "head",
    "pull_request",
    "validation",
    "review",
  ]);
  if (value.contract !== CONTRACT)
    failures.push(`contract must be ${JSON.stringify(CONTRACT)}, not ${shown(value.contract)}`);
  if (value.supervisor !== supervisor)
    failures.push(
      `supervisor ${shown(value.supervisor)} differs from the run's supervisor ${JSON.stringify(supervisor)}`,
    );
  let head = "";
  if (isText(value.head) && HEAD.test(value.head)) head = value.head;
  else failures.push("head must be 40 lower-case hex characters");
  let pullRequest: string | undefined;
  if ("pull_request" in value) {
    if (singleLine(value.pull_request)) pullRequest = value.pull_request;
    else failures.push("pull_request must be a non-empty single-line string");
  }
  let validationRef = "";
  const validation = value.validation;
  if (!isObject(validation)) failures.push("validation must be a JSON object");
  else {
    failures.push(...unknownKeys("validation", validation, ["result", "ref"]));
    if (validation.result !== "pass")
      failures.push(`validation.result must be "pass", not ${shown(validation.result)}`);
    if (singleLine(validation.ref)) validationRef = validation.ref;
    else failures.push("validation.ref must be a non-empty single-line string");
  }
  let reviewer = "";
  let reviewRef = "";
  const authors: string[] = [];
  const review = value.review;
  if (!isObject(review)) failures.push("review must be a JSON object");
  else {
    failures.push(...unknownKeys("review", review, ["result", "reviewer", "authors", "ref"]));
    if (review.result !== "approve") failures.push(`review.result must be "approve", not ${shown(review.result)}`);
    failures.push(...identityFailure("review.reviewer", review.reviewer));
    if (isText(review.reviewer)) reviewer = review.reviewer;
    if (!Array.isArray(review.authors) || review.authors.length === 0)
      failures.push("review.authors must be a non-empty list of identities");
    else
      review.authors.forEach((author, i) => {
        failures.push(...identityFailure(`review.authors[${i}]`, author));
        if (isText(author)) authors.push(author);
      });
    if (singleLine(review.ref)) reviewRef = review.ref;
    else failures.push("review.ref must be a non-empty single-line string");
  }
  if (failures.length > 0) return { ok: false, failures };
  const attestation: Attestation = {
    contract: CONTRACT,
    supervisor,
    head,
    validation: { result: "pass", ref: validationRef },
    review: { result: "approve", reviewer, authors, ref: reviewRef },
  };
  if (pullRequest !== undefined) attestation.pull_request = pullRequest;
  return { ok: true, attestation };
}

/** The shape of an attestation and its supervisor equality; keys are closed at every level. Empty means valid. */
export function attestationFailures(value: Json | undefined, supervisor: string): string[] {
  const read = readAttestation(value, supervisor);
  return read.ok ? [] : read.failures;
}

/**
 * Whether the body's first paragraph is the disclosure sentence for `supervisor`. After at most one leading U+FEFF the
 * body starts with the sentence exactly, and the end of the body, one line ending (LF or CRLF) and the end, or one line
 * ending and a blank line (spaces or tabs, then a line ending or the end) follows it; any other character fails. It
 * parses no Markdown and reads nothing past that blank line. Nothing comes before the sentence, so no construct opens
 * before it; the blank line stops a setext underline, a table delimiter row or a lazy line from joining it; and the
 * sentence holds no `<`, backtick, `[`, `*`, `\` or `&`. A name may hold `_`, and emphasis changes only how it looks.
 */
export function bodyCarriesDisclosure(body: string, supervisor: string): boolean {
  // The supervisor's name in the sentence is held to the one name rule, so a refused name is never recognized.
  if (!SUPERVISOR_PATTERN.test(supervisor)) return false;
  const sentence = unattendedDisclosure(supervisor);
  const start = body.startsWith("\uFEFF") ? 1 : 0;
  if (!body.startsWith(sentence, start)) return false;
  const lineEnding = (at: number): number => (body.startsWith("\n", at) ? 1 : body.startsWith("\r\n", at) ? 2 : 0);
  let at = start + sentence.length;
  if (at === body.length) return true;
  const first = lineEnding(at);
  if (first === 0) return false;
  at += first;
  while (body[at] === " " || body[at] === "\t") at += 1;
  return at === body.length || lineEnding(at) > 0;
}
