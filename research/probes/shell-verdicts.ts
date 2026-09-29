// Usage: bun shell-verdicts.ts <tree-a> <tree-b> <xmodel-dir>. Runs every shell command in the dumped
// sessions through each tree's readOnlyShell and prints the distinct-command count and each disagreement.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [a, b, dir] = process.argv.slice(2) as [string, string, string];
const load = async (tree: string) => (await import(join(tree, "tests/learn/evals/trigger-eval.ts"))).readOnlyShell as (c: string) => boolean;
const [readOnlyA, readOnlyB] = [await load(a), await load(b)];
const { unwrap } = await import(join(b, "tests/learn/evals/subjects/shell.ts"));
const commands = new Set<string>();
for (const rep of ["r1", "r2"]) {
  const transcripts = join(dir, rep, "transcripts");
  for (const subject of readdirSync(transcripts)) {
    for (const f of readdirSync(join(transcripts, subject)).filter((f) => f.endsWith(".json"))) {
      const dump = JSON.parse(readFileSync(join(transcripts, subject, f), "utf8"));
      for (const event of dump.events ?? []) {
        if (event.kind !== "tool") continue;
        const cmd = event.input?.command ?? event.input?.cmd;
        if (typeof cmd === "string") commands.add(unwrap(cmd));
        else if (Array.isArray(cmd)) commands.add(unwrap(cmd.map(String).join(" ")));
      }
    }
  }
}
let differ = 0;
for (const cmd of commands) {
  const [va, vb] = [readOnlyA(cmd), readOnlyB(cmd)];
  if (va === vb) continue;
  differ++;
  console.log(`${va} -> ${vb}\t${cmd}`);
}
console.log(`${commands.size} distinct commands, ${differ} verdicts differ`);
