#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEvidence } from "./evidence.ts";
import type { Io } from "./types.ts";

const USAGE = `t7-pilot: write a T7 evidence document with empty measures.

  scripts/t7-pilot.sh evidence [--cwd REPO]

The verdict is not-run. Repos and measures stay empty. This command does
not name a pilot repository and does not record rework. The maintainer
names the repos. Humans fill the measures. A human records G5.
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

export function runT7Pilot(argv: readonly string[], sink: Io, repo: string = REPO): number {
  const taken = takeCwd(argv);
  if (taken.missing) {
    sink.err("t7-pilot: --cwd needs a path\n");
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

if (import.meta.main) process.exit(runT7Pilot(process.argv.slice(2), io()));
