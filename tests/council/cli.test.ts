import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCouncil } from "../../src/council/cli.ts";
import { parseJson, updated, type JsonValue } from "../helpers/json.ts";
import { processScratch } from "../helpers/process-tmp.ts";

const answer = (choice: string, log: string) =>
  `const p=JSON.parse(await Bun.stdin.text());require('node:fs').appendFileSync(${JSON.stringify(log)},process.argv[1]+' '+Object.keys(p).sort().join(',')+'\\n');console.log(JSON.stringify({choice:${JSON.stringify(choice)},rationale:'blind',model_served:'served-'+process.argv[1]}));`;

function setup(vetoChoice = "yes", pairChoice = "yes") {
  const dir = processScratch("ak-council-");
  const log = join(dir, "seats.log");
  const launcher = (actor: string, choice: string) => ({
    actor,
    lineage: [actor],
    command: ["bun", "-e", answer(choice, log), actor],
  });
  const config = join(dir, "council.json");
  writeFileSync(
    config,
    JSON.stringify({
      pair: [
        { seat: "primary-a", chain: [{ ...launcher("a", pairChoice), requested: "label-a" }] },
        { seat: "primary-b", chain: [launcher("b", pairChoice)] },
      ],
      veto: {
        seat: "veto",
        chain: [
          { actor: "v0", lineage: ["v0"], command: ["bun", "-e", "process.exit(4)"] },
          launcher("v1", vetoChoice),
        ],
      },
    }),
    { mode: 0o600 },
  );
  const card = join(dir, "card.json");
  writeFileSync(card, JSON.stringify({ id: "q1", question: "Adopt it?", options: ["yes", "no"], approve: "yes" }));
  const context = join(dir, "context.md");
  writeFileSync(context, "caller-supplied context");
  return { dir, log, config, card, context, out: join(dir, "record.json") };
}

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCouncil(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

function record(path: string): JsonValue {
  return parseJson(readFileSync(path, "utf8"));
}

describe("ak council run", () => {
  test("three approvals approve, and the record logs requested and served models and grants nothing", async () => {
    const s = setup();
    const result = await run([
      "run",
      "--card",
      s.card,
      "--council-config",
      s.config,
      "--context",
      s.context,
      "--out",
      s.out,
    ]);
    expect(result.code).toBe(0);
    const r = record(s.out);
    expect(r).toMatchObject({ outcome: "approve", choice: "yes", grants: [] });
    expect(r).toHaveProperty("seats");
    expect(r).toMatchObject({
      seats: [
        { role: "primary", seat: "primary-a", actor: "a", model_requested: "label-a", model_served: "served-a" },
        { role: "primary", seat: "primary-b", actor: "b", model_requested: "unspecified", model_served: "served-b" },
        {
          role: "veto",
          actor: "v1",
          model_requested: "unspecified",
          attempts: [{ actor: "v0" }, { actor: "v1" }],
        },
      ],
    });
    expect(JSON.stringify(r)).toContain("launcher exited 4");
    // Every seat saw the same blind payload: the card and the context, never another answer.
    expect(readFileSync(s.log, "utf8").trim().split("\n").toSorted()).toEqual([
      "a card,context,council",
      "b card,context,council",
      "v1 card,context,council",
    ]);
  });

  test("a non-approving veto escalates", async () => {
    const s = setup("no");
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({ outcome: "escalate", choice: null });
  });

  test("a pair that agrees not to approve declines and the veto is never launched", async () => {
    const s = setup("yes", "no");
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(0);
    expect(record(s.out)).toMatchObject({ outcome: "decline", choice: "no" });
    expect(readFileSync(s.log, "utf8")).not.toContain("v1");
  });

  test("a deny-listed context path is refused before any seat launches", async () => {
    const s = setup();
    const secret = join(s.dir, ".env");
    writeFileSync(secret, "NAME=value");
    const result = await run([
      "run",
      "--card",
      s.card,
      "--council-config",
      s.config,
      "--context",
      secret,
      "--out",
      s.out,
    ]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({ outcome: "refused", seats: [] });
    expect(() => readFileSync(s.log)).toThrow();
  });

  test("a refused record carries the card id and the refusal, never the refused content or its digests", async () => {
    const s = setup();
    const token = `ghp_${"a1B2".repeat(10)}`;
    writeFileSync(
      s.card,
      JSON.stringify({ id: "q1", question: `Is ${token} live?`, options: ["yes", "no"], approve: "yes" }),
    );
    const secret = join(s.dir, ".env");
    writeFileSync(secret, "NAME=value");
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--context", secret]);
    expect(result.code).toBe(1);
    const text = result.out.join("\n");
    expect(text).not.toContain(token);
    expect(text).not.toContain("sha256");
    const emitted = parseJson(text);
    expect(emitted).toMatchObject({ outcome: "refused", card: { id: "q1" }, seats: [] });
    expect(emitted).not.toHaveProperty("card.question");
    expect(emitted).not.toHaveProperty("payload");
    expect(JSON.stringify(emitted)).toContain("deny-list");
    expect(JSON.stringify(emitted)).toContain("outbound secret: card");
  });

  test("a seat whose descendant holds the pipes times out on time and the substitute answers", async () => {
    const s = setup();
    const shell = updated(record(s.config), ["veto"], () => ({
      seat: "veto",
      chain: [
        { actor: "hung", lineage: ["hung"], command: ["sh", "-c", "sleep 30 & wait"] },
        {
          actor: "v1",
          lineage: ["v1"],
          command: ["bun", "-e", "console.log(JSON.stringify({choice:'yes',rationale:'blind'}))"],
        },
      ],
    }));
    const limited = updated(shell, ["limits"], () => ({ timeout_ms: 3000 }));
    writeFileSync(s.config, JSON.stringify(limited), { mode: 0o600 });
    const started = Date.now();
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.code).toBe(0);
    expect(record(s.out)).toMatchObject({
      outcome: "approve",
      seats: [{}, {}, { actor: "v1", attempts: [{ actor: "hung", error: "launcher timed out after 3000ms" }, {}] }],
    });
  });

  test("a roster others can read is refused", async () => {
    const s = setup();
    chmodSync(s.config, 0o644);
    const result = await run(["run", "--card", s.card, "--council-config", s.config]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("owner only");
  });

  test("a roster whose veto shares a lineage with the pair is refused", async () => {
    const s = setup();
    const shared = updated(record(s.config), ["veto"], () => ({
      seat: "veto",
      chain: [{ actor: "v", lineage: ["v", "a"], command: ["true"] }],
    }));
    writeFileSync(s.config, JSON.stringify(shared), { mode: 0o600 });
    const result = await run(["run", "--card", s.card, "--council-config", s.config]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("share a lineage");
  });
});
