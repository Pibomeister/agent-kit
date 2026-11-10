#!/usr/bin/env bun
import { readFileSync } from "node:fs";

import { checkAdapterLaunch, parseAdapterLaunch } from "./isolation.ts";

const USAGE = `adapter-isolation-check: score a review-seat adapter launch JSON.

  scripts/adapter-isolation-check.sh <adapter.json>

Exit 0 when no parent canary appears in the seat. Exit 1 when a canary leaks.
Exit 2 when the file is missing or is not a launch document.
`;

function run(args: readonly string[]): number {
  if (args.length !== 1 || args[0] === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const path = args[0];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    process.stderr.write(`adapter-isolation-check: cannot read ${path}\n`);
    return 2;
  }
  const launch = parseAdapterLaunch(text);
  if (launch === null) {
    process.stderr.write(`adapter-isolation-check: ${path} is not a review-seat launch document\n`);
    return 2;
  }
  const verdict = checkAdapterLaunch(launch);
  if (verdict.kind === "pass") {
    process.stdout.write(`adapter-isolation-check: pass ${launch.adapter}\n`);
    return 0;
  }
  process.stderr.write(`adapter-isolation-check: fail ${launch.adapter} leaks ${verdict.leaks.join(",")}\n`);
  return 1;
}

process.exit(run(process.argv.slice(2)));
