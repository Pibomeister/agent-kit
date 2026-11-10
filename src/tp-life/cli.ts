#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderEvidence } from "./evidence.ts";
import { flagValue } from "./parse.ts";
import { checkReceipt, writeOracleReceipt } from "./receipt.ts";
import type { Io } from "./types.ts";

const USAGE = `tp-life: fixture oracle receipts and the G4 evidence record.

  scripts/tp-life.sh fixture [--port PORT] [--broken pending|success|failure|disconnect|duplicate|unknown]
  scripts/tp-life.sh oracle --base-url URL [--out report.json]
  scripts/tp-life.sh receipt write --oracle-json report.json --out receipt.json
  scripts/tp-life.sh receipt check receipt.json
  scripts/tp-life.sh evidence

evidence prints the G4 record. The verdict is computed from receipts under
research/tp-life/receipts/ that bind to HEAD. The template verdict is ignored.
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
  const cwd = flagValue(argv, "--cwd") ?? REPO;
  if (argv[0] === "receipt" && argv[1] === "write") {
    const oracleJson = flagValue(argv, "--oracle-json");
    const out = flagValue(argv, "--out");
    if (oracleJson === undefined || out === undefined) {
      sink.err("usage: receipt write --oracle-json <file> --out <file>\n");
      return 2;
    }
    return writeOracleReceipt(cwd, oracleJson, out, sink);
  }
  if (argv[0] === "receipt" && argv[1] === "check") {
    const path = argv[2];
    if (path === undefined) {
      sink.err("usage: receipt check <file>\n");
      return 2;
    }
    return checkReceipt(cwd, path, sink);
  }
  if (argv[0] === "evidence") return renderEvidence(cwd, sink);
  sink.err(USAGE);
  return 2;
}

if (import.meta.main) process.exit(runTpLife(process.argv.slice(2), io()));
