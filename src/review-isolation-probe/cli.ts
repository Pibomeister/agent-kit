#!/usr/bin/env bun
import { runProbe } from "./run.ts";

const code = runProbe(process.argv.slice(2), process.env, {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
});
process.exit(code);
