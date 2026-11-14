#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEvidence } from "./evidence.ts";
import type { Io } from "./types.ts";

const USAGE = `t4-held-out: write a T4 evidence document with empty scores.

  scripts/t4-held-out.sh evidence [--cwd REPO]

The verdict is not-run. Scores stay empty. This command does not hold the
corpus and does not adjudicate. The curator and two blind adjudicators fill
the record. A human records G3.
`;

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

function io(): Io {
  return {
    out: (text: string) => {
      process.stdout.write(text);
    },
    err: (text: string) => {
      process.stderr.write(text);
    },
  };
}

interface TakenCwd {
  cwd: string | undefined;
  rest: string[];
  missing: boolean;
}

function takeCwd(argv: readonly string[]): TakenCwd {
  const index = argv.indexOf("--cwd");
  if (index < 0) return { cwd: undefined, rest: [...argv], missing: false };
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return { cwd: undefined, rest: [...argv], missing: true };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (i === index || i === index + 1) continue;
    const item = argv[i];
    if (item !== undefined) rest.push(item);
  }
  return { cwd: value, rest, missing: false };
}

export function runT4HeldOut(argv: readonly string[], sink: Io, repo: string = REPO): number {
  const taken = takeCwd(argv);
  if (taken.missing) {
    sink.err("t4-held-out: --cwd needs a path\n");
    return 2;
  }
  if (taken.rest.length === 1 && taken.rest[0] === "--help") {
    sink.out(USAGE);
    return 0;
  }
  if (taken.rest.length === 1 && taken.rest[0] === "evidence") return renderEvidence(taken.cwd ?? repo, sink);
  sink.err(USAGE);
  return 2;
}

if (import.meta.main) process.exit(runT4HeldOut(process.argv.slice(2), io()));
