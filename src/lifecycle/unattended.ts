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

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

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
export const sha256Digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const exec = (cmd: string, args: readonly string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: r.stdout ?? "" };
};

/**
 * The active policy: the environment first, else the default-branch configuration at the local
 * `refs/remotes/origin/HEAD`, never the working tree or the task branch. Undefined is the legacy policy.
 * Only the configuration's `policy` key is read; any other key is ignored.
 */
export function resolvePolicy(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; policy?: Policy } | { ok: false; reason: string } {
  const rawSupervisor = env[SUPERVISOR_ENV]?.trim();
  const supervisor = rawSupervisor !== undefined && rawSupervisor !== "" ? rawSupervisor : undefined;
  if (supervisor !== undefined && hasControlChar(supervisor))
    return { ok: false, reason: `${SUPERVISOR_ENV} must not contain control characters` };
  const stamp = (source: string): Policy =>
    supervisor === undefined ? { name: UNATTENDED, source } : { name: UNATTENDED, source, supervisor };
  const value = env[POLICY_ENV];
  if (value !== undefined && value !== "") {
    if (value !== UNATTENDED)
      return { ok: false, reason: `${POLICY_ENV} accepts only '${UNATTENDED}', not '${value}'` };
    return { ok: true, policy: stamp("environment") };
  }
  const rev = exec("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"], project);
  const revision = rev.out.trim();
  if (rev.code !== 0 || revision === "") return { ok: true };
  const file = exec("git", ["show", `${revision}:${CONFIG_FILE}`], project);
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
  if (!isText(named) || named === "" || named !== named.trim() || hasControlChar(named))
    failures.push("supervisor must be a non-empty string with no control character and no surrounding whitespace");
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

/** The shape of an attestation and its supervisor equality; keys are closed at every level. Empty means valid. */
export function attestationFailures(value: Json | undefined, supervisor: string): string[] {
  if (!isObject(value)) return ["attestation must be a JSON object"];
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
  if (!isText(value.head) || !HEAD.test(value.head)) failures.push("head must be 40 lower-case hex characters");
  if ("pull_request" in value && !singleLine(value.pull_request))
    failures.push("pull_request must be a non-empty single-line string");
  const validation = value.validation;
  if (!isObject(validation)) failures.push("validation must be a JSON object");
  else {
    failures.push(...unknownKeys("validation", validation, ["result", "ref"]));
    if (validation.result !== "pass")
      failures.push(`validation.result must be "pass", not ${shown(validation.result)}`);
    if (!singleLine(validation.ref)) failures.push("validation.ref must be a non-empty single-line string");
  }
  const review = value.review;
  if (!isObject(review)) failures.push("review must be a JSON object");
  else {
    failures.push(...unknownKeys("review", review, ["result", "reviewer", "authors", "ref"]));
    if (review.result !== "approve") failures.push(`review.result must be "approve", not ${shown(review.result)}`);
    failures.push(...identityFailure("review.reviewer", review.reviewer));
    if (!Array.isArray(review.authors) || review.authors.length === 0)
      failures.push("review.authors must be a non-empty list of identities");
    else review.authors.forEach((author, i) => failures.push(...identityFailure(`review.authors[${i}]`, author)));
    if (!singleLine(review.ref)) failures.push("review.ref must be a non-empty single-line string");
  }
  return failures;
}

const textOf = (v: Json | undefined): string => (isText(v) ? v : "");

/** The typed attestation when `value` passes `attestationFailures` for `supervisor`, else the failures. */
export function readAttestation(
  value: Json | undefined,
  supervisor: string,
): { ok: true; attestation: Attestation } | { ok: false; failures: string[] } {
  const failures = attestationFailures(value, supervisor);
  if (failures.length > 0 || !isObject(value)) return { ok: false, failures };
  const { head, pull_request: pullRequest, validation, review } = value;
  if (!isText(head) || !isObject(validation) || !isObject(review) || !Array.isArray(review.authors))
    return { ok: false, failures: ["attestation is not readable after validation"] };
  const authors = review.authors.filter(isText);
  const attestation: Attestation = {
    contract: CONTRACT,
    supervisor,
    head,
    validation: { result: "pass", ref: textOf(validation.ref) },
    review: { result: "approve", reviewer: textOf(review.reviewer), authors, ref: textOf(review.ref) },
  };
  if (isText(pullRequest)) attestation.pull_request = pullRequest;
  return { ok: true, attestation };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether the body carries the disclosure sentence for `supervisor`: after HTML comments and backtick or tilde
 * fenced blocks are removed, an exact substring test with no whitespace normalisation. An unclosed comment or
 * fence hides the rest of the body. It does not see text that renders hidden by other means.
 */
export function bodyCarriesDisclosure(body: string, supervisor: string): boolean {
  const shownLines: string[] = [];
  let open: { char: string; length: number } | undefined;
  for (const line of body.replaceAll(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n")) {
    const fence = FENCE.exec(line)?.[1];
    if (open === undefined) {
      if (fence !== undefined) open = { char: fence[0] ?? "", length: fence.length };
      else shownLines.push(line);
    } else if (
      fence?.[0] === open.char &&
      fence.length >= open.length &&
      line.slice(FENCE.exec(line)?.[0].length).trim() === ""
    )
      open = undefined;
  }
  return shownLines.join("\n").includes(unattendedDisclosure(supervisor));
}
