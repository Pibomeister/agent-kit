import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Spawned = ReturnType<typeof Bun.spawn>;
const liveChildren = new Set<Spawned>();

async function reap(child: Spawned): Promise<void> {
  child.kill("SIGKILL");
  await child.exited.catch(() => undefined);
  liveChildren.delete(child);
}

afterAll(async () => {
  await Promise.all([...liveChildren].map(reap));
});

/** Hang until killed, argv[3] (the test runner) exits, or 120s pass. Immediate ppid is not watched. Writes argv[2] atomically. */
const HANG_UNTIL_REAPED = `const fs = require("node:fs");
const pidFile = process.argv[2];
const keeper = Number(process.argv[3]);
const deadline = Date.now() + 120000;
const tmp = pidFile + "." + process.pid;
fs.writeFileSync(tmp, String(process.pid));
fs.renameSync(tmp, pidFile);
setInterval(function () {
  if (Date.now() > deadline) process.exit(0);
  try {
    process.kill(keeper, 0);
  } catch {
    process.exit(0);
  }
}, 200);
`;

function writeHangHelper(dir: string): string {
  const script = join(dir, "hang-until-reaped.js");
  writeFileSync(script, HANG_UNTIL_REAPED);
  return script;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readLivePid(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  expect(alive(pid)).toBe(true);
  return pid;
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

  for (const [name, wrap] of [
    ["after a newline", (token: string) => `Is this live?\n${token}`],
    ["after a tab", (token: string) => `Is this live?\t${token}`],
    ["in quotes", (token: string) => `Is "${token}" live?`],
  ] as const)
    test(`a credential ${name} in the card is refused before any seat launches`, async () => {
      const s = setup();
      const token = `ghp_${"a1B2".repeat(10)}`;
      writeFileSync(
        s.card,
        JSON.stringify({ id: "q1", question: wrap(token), options: ["yes", "no"], approve: "yes" }),
      );
      const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
      expect(result.code).toBe(1);
      expect(record(s.out)).toMatchObject({ outcome: "refused", seats: [] });
      expect(JSON.stringify(record(s.out))).toContain("outbound secret: card");
      expect(() => readFileSync(s.log)).toThrow();
    });

  test("an escaped credential in a JSON context file is refused before any seat launches", async () => {
    const s = setup();
    const token = `ghp_${"a1B2".repeat(10)}`;
    writeFileSync(s.context, JSON.stringify({ log: `token:\n${token}` }));
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
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({ outcome: "refused", seats: [] });
    expect(JSON.stringify(record(s.out))).toContain("outbound secret: context.md");
    expect(JSON.stringify(record(s.out))).not.toContain(token);
    expect(() => readFileSync(s.log)).toThrow();
  });

  const fixedOptions: [string, JsonValue][] = [
    ["limits", { max_bytes: 1 << 30 }],
    ["deny", ["private-*"]],
  ];
  for (const [name, option] of fixedOptions)
    test(`a roster naming ${name} is refused: the gate's limits are fixed`, async () => {
      const s = setup();
      writeFileSync(s.config, JSON.stringify(updated(record(s.config), [name], () => option)), { mode: 0o600 });
      const result = await run(["run", "--card", s.card, "--council-config", s.config]);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain("invalid council configuration");
    });

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    test(`${signal} ends a hung seat's whole process group`, async () => {
      const s = setup();
      const pidFile = join(s.dir, "descendant.pid");
      const hang = writeHangHelper(s.dir);
      const hung = updated(record(s.config), ["pair", 0, "chain"], () => [
        {
          actor: "a",
          lineage: ["a"],
          command: ["sh", "-c", `node ${shQuote(hang)} ${shQuote(pidFile)} ${process.pid} & wait`],
        },
      ]);
      writeFileSync(s.config, JSON.stringify(hung), { mode: 0o600 });
      const child = Bun.spawn(["bun", "src/cli.ts", "council", "run", "--card", s.card, "--council-config", s.config], {
        cwd: join(import.meta.dir, "..", ".."),
        stdout: "ignore",
        stderr: "ignore",
      });
      liveChildren.add(child);
      try {
        const ready = Date.now() + 10_000;
        while (Date.now() < ready) {
          if (existsSync(pidFile)) {
            const pid = Number(readFileSync(pidFile, "utf8").trim());
            if (Number.isInteger(pid) && pid > 0 && alive(pid)) break;
          }
          await Bun.sleep(25);
        }
        const descendant = readLivePid(pidFile);
        child.kill(signal);
        expect(await child.exited).toBe(code);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(descendant)) await Bun.sleep(25);
        expect(alive(descendant)).toBe(false);
      } finally {
        await reap(child);
      }
    }, 60_000);

  test("a roster others can read is refused", async () => {
    const s = setup();
    chmodSync(s.config, 0o644);
    const result = await run(["run", "--card", s.card, "--council-config", s.config]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("owner only");
  });

  test("a roster that names fail-closed as a veto actor is refused", async () => {
    const s = setup();
    const spoofed = updated(record(s.config), ["veto"], () => ({
      seat: "veto",
      chain: [{ actor: "fail-closed", lineage: ["fail-closed"], command: ["true"] }],
    }));
    writeFileSync(s.config, JSON.stringify(spoofed), { mode: 0o600 });
    const result = await run(["run", "--card", s.card, "--council-config", s.config]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("must not name actor fail-closed");
  });

  test("a roster that names fail-closed in a veto lineage is refused", async () => {
    const s = setup();
    const spoofed = updated(record(s.config), ["veto"], () => ({
      seat: "veto",
      chain: [{ actor: "v9", lineage: ["v9", "fail-closed"], command: ["true"] }],
    }));
    writeFileSync(s.config, JSON.stringify(spoofed), { mode: 0o600 });
    const result = await run(["run", "--card", s.card, "--council-config", s.config]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("must not name actor fail-closed");
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

const emit = (text: string, log: string, actor: string) =>
  `require('node:fs').appendFileSync(${JSON.stringify(log)},${JSON.stringify(actor)}+'\\n');console.log(${JSON.stringify(text)});`;

function worthySetup(vetoText: string, substitute?: string, primaries?: [string, string]) {
  const dir = processScratch("ak-council-");
  const log = join(dir, "seats.log");
  const worthy = JSON.stringify({ choice: "WORTHY", rationale: "blind" });
  const pair = (actor: string, text: string) => ({
    actor,
    lineage: [actor],
    command: ["bun", "-e", emit(text, log, actor)],
  });
  const vetoChain = [{ actor: "v1", lineage: ["v1"], command: ["bun", "-e", emit(vetoText, log, "v1")] }];
  if (substitute !== undefined)
    vetoChain.push({ actor: "v2", lineage: ["v2"], command: ["bun", "-e", emit(substitute, log, "v2")] });
  const config = join(dir, "council.json");
  writeFileSync(
    config,
    JSON.stringify({
      pair: [
        { seat: "primary-a", chain: [pair("a", primaries?.[0] ?? worthy)] },
        { seat: "primary-b", chain: [pair("b", primaries?.[1] ?? worthy)] },
      ],
      veto: { seat: "veto", chain: vetoChain },
    }),
    { mode: 0o600 },
  );
  const card = join(dir, "card.json");
  writeFileSync(
    card,
    JSON.stringify({ id: "q1", question: "Ship it?", options: ["WORTHY", "REJECT"], approve: "WORTHY" }),
  );
  return { log, config, card, out: join(dir, "record.json") };
}

describe("ak council run parses a seat verdict strictly", () => {
  const worthy = JSON.stringify({ choice: "WORTHY", rationale: "blind" });
  const reject = JSON.stringify({ choice: "REJECT", rationale: "the change is not worthy" });

  test("a transcript that mentions WORTHY and ends REJECT is REJECT", async () => {
    const s = worthySetup(`I would have said WORTHY after the green tests.\n${reject}`, reject);
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({
      outcome: "escalate",
      choice: null,
      causes: ["the blind veto seat did not approve; it chose REJECT"],
      seats: [{ choice: "WORTHY" }, { choice: "WORTHY" }, { role: "veto", actor: "v2", choice: "REJECT" }],
    });
    expect(readFileSync(s.log, "utf8")).toContain("v2");
    expect(JSON.stringify(record(s.out))).toContain("not a JSON object");
  });

  test("garbage failover still asks the WORTHY substitute", async () => {
    const s = worthySetup("discussed WORTHY at length with no final field", worthy);
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(0);
    expect(record(s.out)).toMatchObject({ outcome: "approve", choice: "WORTHY" });
    expect(readFileSync(s.log, "utf8")).toContain("v2");
  });

  test("an exhausted chain with no valid answer is REJECT", async () => {
    const s = worthySetup("discussed WORTHY at length with no final field");
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({
      outcome: "escalate",
      causes: ["the blind veto seat gave no valid verdict; recorded REJECT fail-closed"],
      seats: [{}, {}, { role: "veto", actor: "fail-closed", choice: "REJECT" }],
    });
    expect(JSON.stringify(record(s.out))).toContain("not a JSON object");
    expect(JSON.stringify(record(s.out))).toContain("seat veto v1:");
  });

  test("an exact WORTHY without a rationale is invalid", async () => {
    const s = worthySetup('{"choice":"WORTHY"}');
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({
      outcome: "escalate",
      seats: [{}, {}, { role: "veto", actor: "fail-closed", choice: "REJECT" }],
    });
  });

  test("duplicated structured choices fail closed to REJECT", async () => {
    const s = worthySetup(`${worthy}\n${reject}`);
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({ seats: [{}, {}, { role: "veto", choice: "REJECT" }] });
  });

  test("conflicting choice keys fail closed to REJECT", async () => {
    const s = worthySetup('{"choice":"WORTHY","choice":"REJECT","rationale":"both"}');
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({ seats: [{}, {}, { role: "veto", choice: "REJECT" }] });
  });

  for (const [name, text] of [
    ["a wrong-case", '{"choice":"Reject","rationale":"cased"}'],
    ["an unknown", '{"choice":"MAYBE","rationale":"other"}'],
  ] as const)
    test(`${name} choice is REJECT`, async () => {
      const s = worthySetup(text);
      const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
      expect(result.code).toBe(1);
      expect(record(s.out)).toMatchObject({ seats: [{}, {}, { role: "veto", choice: "REJECT" }] });
    });

  test("a duplicated non-choice key is invalid", async () => {
    const s = worthySetup('{"choice":"WORTHY","rationale":"a","rationale":"b"}');
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({
      outcome: "escalate",
      seats: [{}, {}, { role: "veto", actor: "fail-closed", choice: "REJECT" }],
    });
    expect(JSON.stringify(record(s.out))).toContain("duplicate key");
  });

  test("two exhausted primaries escalate", async () => {
    const s = worthySetup(worthy, undefined, ["not a verdict", "also not a verdict"]);
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({
      outcome: "escalate",
      choice: null,
      seats: [
        { role: "primary", actor: null, choice: null },
        { role: "primary", actor: null, choice: null },
      ],
    });
    expect(JSON.stringify(record(s.out))).toContain("a primary seat was unavailable");
    expect(readFileSync(s.log, "utf8")).not.toContain("v1");
  });

  test("one exhausted primary and one REJECT escalate rather than decline", async () => {
    const s = worthySetup(worthy, undefined, ["not a verdict", reject]);
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(1);
    expect(record(s.out)).toMatchObject({
      outcome: "escalate",
      choice: null,
      seats: [
        { role: "primary", actor: null, choice: null },
        { role: "primary", actor: "b", choice: "REJECT" },
      ],
    });
    expect(JSON.stringify(record(s.out))).toContain("a primary seat was unavailable");
    expect(readFileSync(s.log, "utf8")).not.toContain("v1");
  });

  test("an exact WORTHY object still approves", async () => {
    const s = worthySetup(worthy);
    const result = await run(["run", "--card", s.card, "--council-config", s.config, "--out", s.out]);
    expect(result.code).toBe(0);
    expect(record(s.out)).toMatchObject({ outcome: "approve", choice: "WORTHY" });
  });
});
