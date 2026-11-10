#!/usr/bin/env bun
import { qualifyT3 } from "./t3.ts";

const USAGE = `t3-qualify: write a T3 evidence document with empty trace slots.

  scripts/t3-qualify.sh <host>

The verdict is not-qualified. strict is false. Slots stay empty. This command
does not call a host and does not invent traces.
`;

function run(args: readonly string[]): number {
  if (args.length !== 1 || args[0] === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const evidence = qualifyT3(args[0]);
  if (evidence === null) {
    process.stderr.write(`t3-qualify: host must be a directory under adapters/, not ${args[0]}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return 0;
}

process.exit(run(process.argv.slice(2)));
