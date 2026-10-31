/**
 * The council roster: a local, owner-only file that names who fills each
 * council seat and in what order substitutes are tried. Its schema is
 * committed and carries no values; the values stay on the operator's host.
 *
 * A seat's `chain` is ordered. The first launcher is the seat's holder and
 * each later one is a substitute, tried only when every earlier launcher
 * failed to start or returned no valid answer. A valid answer is never
 * replaced. `requested` is the operator's own label for what the launcher
 * asks for; the council records it and never routes on it.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";

import { sharesLineage } from "../runner/lineage.ts";

/** How long one launcher may run: 15 minutes. */
export const DEFAULT_TIMEOUT_MS = 900_000;

export interface CouncilLauncher {
  actor: string;
  lineage: string[];
  command: string[];
  requested?: string;
  /** Names of caller environment variables `ak council run` passes to this launcher, beyond the base set. */
  env?: string[];
}

export interface CouncilSeat {
  seat: string;
  chain: CouncilLauncher[];
}

export interface CouncilConfig {
  pair?: CouncilSeat[];
  veto: CouncilSeat;
}

/** A council seat's answer. `model_served` is the launcher's own report of what answered, when it has one. */
export interface CouncilAnswer {
  choice: string;
  rationale: string;
  model_served?: string;
}

const ajv = new Ajv2020({ strict: false });
const nonEmpty = { type: "string", minLength: 1 };
const launcher = {
  type: "object",
  additionalProperties: false,
  required: ["actor", "lineage", "command"],
  properties: {
    actor: nonEmpty,
    lineage: { type: "array", minItems: 1, items: nonEmpty },
    command: { type: "array", minItems: 1, items: nonEmpty },
    requested: nonEmpty,
    env: { type: "array", items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },
  },
};
const seat = {
  type: "object",
  additionalProperties: false,
  required: ["seat", "chain"],
  properties: {
    seat: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
    chain: { type: "array", minItems: 1, items: launcher },
  },
};

export const isCouncilConfig = ajv.compile<CouncilConfig>({
  type: "object",
  additionalProperties: false,
  required: ["veto"],
  properties: {
    pair: { type: "array", minItems: 2, maxItems: 2, items: seat },
    veto: seat,
  },
});

export const isCouncilAnswer = ajv.compile<CouncilAnswer>({
  type: "object",
  additionalProperties: false,
  required: ["choice", "rationale"],
  properties: { choice: { type: "string" }, rationale: { type: "string" }, model_served: nonEmpty },
});

/** Every launcher of every seat must be independent of every launcher of every other seat. */
export function rosterProblems(seats: readonly CouncilSeat[]): string[] {
  const problems: string[] = [];
  if (new Set(seats.map((s) => s.seat)).size !== seats.length) problems.push("council seats must have distinct ids");
  for (const [i, a] of seats.entries()) {
    if (new Set(a.chain.map((l) => l.actor)).size !== a.chain.length)
      problems.push(`seat ${a.seat} names an actor twice in its chain`);
    for (const l of a.chain)
      if (!l.lineage.includes(l.actor))
        problems.push(`seat ${a.seat} launcher ${l.actor} omits itself from its lineage`);
    for (const b of seats.slice(i + 1))
      if (a.chain.some((l) => b.chain.some((m) => sharesLineage(l, m))))
        problems.push(`seats ${a.seat} and ${b.seat} share a lineage`);
  }
  return problems;
}

/**
 * Reads a roster the operator alone may read and write. A file another
 * account can read could leak the roster; one another account can write
 * could reseat the council.
 */
export function readCouncilConfig(path: string): CouncilConfig {
  const real = realpathSync(path);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("council configuration is not a regular file");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("council configuration must be owner only: no group or other permission bits");
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error("council configuration must be owned by the operator running the council");
  const value: unknown = JSON.parse(readFileSync(real, "utf8"));
  if (!isCouncilConfig(value))
    throw new Error(`invalid council configuration: ${JSON.stringify(isCouncilConfig.errors)}`);
  return value;
}
