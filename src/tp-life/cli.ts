#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEvidence } from "./evidence.ts";
import { flagValue, takeFlag } from "./parse.ts";
import { checkReceipt, writeOracleReceipt } from "./receipt.ts";
import type { Io } from "./types.ts";

const USAGE = `tp-life: fixture oracle receipts and the G4 evidence record.

  scripts/tp-life.sh fixture [--port PORT] [--broken pending|success|failure|disconnect|duplicate|unknown]
  scripts/tp-life.sh oracle --base-url URL [--out report.json]
  scripts/tp-life.sh receipt write --oracle-json report.json --out receipt.json
  scripts/tp-life.sh receipt check [--cwd REPO] receipt.json
  scripts/tp-life.sh evidence [--cwd REPO] [--receipts-dir DIR]

evidence always prints G4 as not-run. It also prints oracle_sub_verdict,
machine-checked from bound receipts. red-to-green needs a failed duplicate-only
receipt and a passed receipt on the same head. Duplicate copies count once.
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

export function runTpLife(argv: readonly string[], sink: Io): number {
  const cwdTaken = takeFlag(argv, "--cwd");
  const receiptsTaken = takeFlag(cwdTaken.rest, "--receipts-dir");
  const rest = receiptsTaken.rest;
  const cwd = cwdTaken.value ?? REPO;
  if (rest[0] === "receipt" && rest[1] === "write") {
    const oracleJson = flagValue(rest, "--oracle-json");
    const out = flagValue(rest, "--out");
    if (oracleJson === undefined || out === undefined) {
      sink.err("usage: receipt write --oracle-json <file> --out <file>\n");
      return 2;
    }
    return writeOracleReceipt(cwd, oracleJson, out, sink);
  }
  if (rest[0] === "receipt" && rest[1] === "check") {
    const path = rest[2];
    if (path === undefined) {
      sink.err("usage: receipt check <file>\n");
      return 2;
    }
    return checkReceipt(cwd, path, sink);
  }
  if (rest[0] === "evidence") return renderEvidence(cwd, sink, receiptsTaken.value);
  sink.err(USAGE);
  return 2;
}

if (import.meta.main) process.exit(runTpLife(process.argv.slice(2), io()));
