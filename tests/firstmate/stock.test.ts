import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runFirstmate } from "../../src/firstmate/cli.ts";
import type { Check } from "../../src/firstmate/checks.ts";
import { preflightStock, stockBrief } from "../../src/firstmate/stock.ts";
import { processScratch } from "../helpers/process-tmp.ts";
import { makeTree } from "../helpers/tree.ts";
import { makeBundle, makeProject, REPO } from "./fixture.ts";

function stockHome() {
  return makeTree({
    "bin/fm-brief.sh": "#!/bin/sh\n",
    "bin/fm-spawn.sh": "#!/bin/sh\n",
    "bin/fm-tasks-axi.sh": "#!/bin/sh\n",
  });
}

describe("stock Firstmate adapter", () => {
  test("preflight passes without patches, a pinned Firstmate commit or auto_fix zeros", () => {
    const home = stockHome();
    const project = makeProject("commands:\n  test: bun test\nauto_fix:\n  test: 3\n  lint: 3\n  ci: 3\n");
    const bundle = makeBundle();
    const result = preflightStock(home, project, "codex", REPO, bundle);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("guided");
    expect(result.checks.some((check) => check.id === "no-mistakes-auto-fix")).toBe(false);
    expect(result.checks.map((check) => check.id)).toEqual([
      "stock-firstmate",
      "project",
      "host-capabilities",
      "skill-bundle",
      "runner",
      "supervisor-token",
      "delivery",
    ]);
    const out: string[] = [];
    const code = runFirstmate(
      ["preflight", "--fm-home", home, "--project", project, "--host", "codex", "--bundle-dir", bundle, "--json"],
      {
        out: (line) => out.push(line),
        err: () => {
          throw new Error("unexpected preflight error");
        },
      },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain('"mode": "guided"');
  });

  test("a normal brief carries a runner start without adding a Firstmate delivery mode", () => {
    const rendered = stockBrief({
      run: "toy-run",
      charter: "/private/charter.json",
      socket: "/private/runner.sock",
      workerToken: "w".repeat(48),
      delivery: "no-mistakes",
    });
    expect(rendered).toContain("start_authority.kind is standing-grant");
    expect(rendered).toContain("Firstmate copies the");
    expect(rendered).toContain("Your worker token cannot call collect");
    expect(rendered).toContain("existing status file");
    expect(rendered).toContain("no-mistakes delivery contract");
    expect(rendered).not.toContain("--mode agent-kit");
    const out: string[] = [];
    const code = runFirstmate(
      [
        "brief",
        "--run",
        "toy-run",
        "--charter",
        "/private/charter.json",
        "--runner-socket",
        "/private/runner.sock",
        "--worker-token",
        "w".repeat(48),
        "--delivery",
        "local-only",
      ],
      {
        out: (line) => out.push(line),
        err: () => {
          throw new Error("unexpected brief error");
        },
      },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("local-only delivery contract");
    expect(() =>
      stockBrief({
        run: "toy-run",
        charter: "/private/charter.json\nforged",
        socket: "/private/runner.sock",
        workerToken: "w".repeat(48),
        delivery: "no-mistakes",
      }),
    ).toThrow();
    expect(() =>
      stockBrief({
        run: "ENG-4133",
        charter: "/private/charter.json",
        socket: "/private/runner.sock",
        workerToken: "w".repeat(48),
        delivery: "no-mistakes",
      }),
    ).toThrow();
  });
});

const CHECK_IDS = [
  "stock-firstmate",
  "project",
  "host-capabilities",
  "skill-bundle",
  "runner",
  "supervisor-token",
  "delivery",
];
const GUIDE = join(REPO, "adapters", "firstmate", "SUPERVISOR.md");
const GUIDE_OPENING = "The stock preflight reports guided mode without a runner socket.";

type State = "no-socket" | "socket" | "not-socket";

/** Shared phrases: id, exact substring, the state whose runner detail carries it, and whether the guide passage must too. */
const PHRASES: ReadonlyArray<readonly [string, string, State, boolean]> = [
  ["N1", "reads no run state, grant, seat or receipt", "no-socket", true],
  [
    "N2",
    "if the run holds a bypass or delegated grant record or its build gate records an implementer seat",
    "no-socket",
    true,
  ],
  ["N3", "required evidence or a recipe", "no-socket", true],
  ["N4", "not runner-attested", "no-socket", true],
  ["N5", "recorded later", "no-socket", true],
  ["N6", "worker-attested", "no-socket", true],
  ["S1", "only the file type was checked", "socket", true],
  ["S2", "nothing connected", "socket", true],
  ["S3", "not liveness, identity or qualification", "socket", true],
  ["S4", "does not establish a configured qualified producer or a passed gate", "socket", true],
  ["F1", "is not a socket-type file", "not-socket", false],
];
const FORBIDDEN = [
  "live runner socket",
  "validates its standing grant",
  "socket is live",
  "readiness",
  "verification closes",
];

/** The guide passage: from its opening sentence to the next blank line, with line wraps collapsed. */
function guidePassage(text: string): string {
  const start = text.indexOf(GUIDE_OPENING);
  if (start < 0) throw new Error(`the guide has no paragraph beginning "${GUIDE_OPENING}"`);
  const end = text.indexOf("\n\n", start);
  return text.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
}

/** Every way the details and the guide passage depart from the shared phrase list and the forbidden list. */
function tieViolations(guide: string, details: Record<State, string[]>): string[] {
  const found: string[] = [];
  for (const [id, phrase, state, inGuide] of PHRASES) {
    for (const detail of details[state])
      if (!detail.includes(phrase)) found.push(`${id} missing from a ${state} detail`);
    if (inGuide && !guide.includes(phrase)) found.push(`${id} missing from the guide passage`);
  }
  for (const text of [guide, ...Object.values(details).flat()])
    for (const phrase of FORBIDDEN) if (text.includes(phrase)) found.push(`forbidden "${phrase}" present`);
  return found;
}

/**
 * A socket-type file at a path of at most 100 characters (AF_UNIX allows 104 on macOS; Linux is unmeasured) with
 * no listener: a child listens, is SIGKILLed, and leaves the file behind. Throws, so the test fails, if it cannot.
 */
async function staleSocket(): Promise<string> {
  const path = join(processScratch("aks-"), "s");
  if (path.length > 100) throw new Error(`socket path ${path} is over 100 characters`);
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  try {
    const first = await child.stdout.getReader().read();
    if (!new TextDecoder().decode(first.value).includes("up"))
      throw new Error("the socket listener child did not start");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  child.kill("SIGKILL");
  await child.exited;
  if (!statSync(path).isSocket()) throw new Error(`could not make a socket-type file with no listener at ${path}`);
  return path;
}

function checkOf(checks: Check[], id: string): Check {
  const found = checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no ${id} check in ${checks.map((check) => check.id).join(", ")}`);
  return found;
}

/** A live socket (listening in this process) and a stale one (listener killed), for the socket-type file states. */
async function sockets() {
  const live = join(processScratch("aks-"), "l");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(live, resolve));
  try {
    return { live, stale: await staleSocket(), close: () => server.close() };
  } catch (error) {
    server.close();
    throw error;
  }
}

describe("stock preflight runner check", () => {
  const home = stockHome();
  const project = makeProject();
  const bundle = makeBundle({ "skills/autopilot/SKILL.md": "---\nname: autopilot\n---\n" });
  const regular = join(processScratch("aks-"), "file");
  const missing = join(processScratch("aks-"), "missing");
  writeFileSync(regular, "not a socket");
  const run = (socket?: string) => preflightStock(home, project, "codex", REPO, bundle, socket);
  const runner = (socket?: string) => checkOf(run(socket).checks, "runner");

  test("reporting contract: ids, order, pass or fail, mode and exit status hold in all five input states", async () => {
    const { live, stale, close } = await sockets();
    try {
      const cases: Array<[string, string | undefined, boolean, "guided" | "runner-candidate", number]> = [
        ["no socket", undefined, true, "guided", 0],
        ["socket-type file", live, true, "runner-candidate", 0],
        ["socket-type file with no listener", stale, true, "runner-candidate", 0],
        ["missing path", missing, false, "runner-candidate", 1],
        ["regular file", regular, false, "runner-candidate", 1],
      ];
      for (const [label, socket, ok, mode, exit] of cases) {
        const result = run(socket);
        expect(
          result.checks.map((check) => check.id),
          label,
        ).toEqual(CHECK_IDS);
        expect(checkOf(result.checks, "runner").ok, label).toBe(ok);
        expect(
          result.checks.filter((check) => check.id !== "runner").every((check) => check.ok),
          label,
        ).toBe(true);
        expect(result.ok, label).toBe(ok);
        expect(result.mode, label).toBe(mode);
        const out: string[] = [];
        const code = runFirstmate(
          [
            "preflight",
            "--fm-home",
            home,
            "--project",
            project,
            "--host",
            "codex",
            "--bundle-dir",
            bundle,
            "--json",
          ].concat(socket === undefined ? [] : ["--runner-socket", socket]),
          { out: (line) => out.push(line), err: () => {} },
        );
        expect(code, label).toBe(exit);
        expect(JSON.parse(out.join("\n")), `${label} json`).toEqual(result);
        const others = result.checks.filter((check) => check.id !== "runner");
        expect(checkOf(others, "stock-firstmate").detail).toBe(
          "normal brief and spawn commands are present; no patch or pinned commit required",
        );
        expect(checkOf(others, "delivery").detail).toBe(
          "use the task's normal no-mistakes or direct-PR mode; an auto-fix invalidates old runner evidence and requires new verification",
        );
        expect(others, label).toEqual(run(undefined).checks.filter((check) => check.id !== "runner"));
      }
    } finally {
      close();
    }
  });

  test("no socket: the previous detail leads and the conditional consequence follows without asserting a grant", () => {
    const detail = runner().detail;
    expect(detail.startsWith("no runner socket supplied; guided checkpoints only")).toBe(true);
    expect(detail).toContain("evidence is checked explicitly or a task-bound run record exists");
    expect(detail).toContain("every such receipt when an implementer seat is recorded");
    expect(detail).toContain("with only a grant record");
    expect(detail).toContain("autonomous-ship");
  });

  test("a socket-type file, live or stale, reports only the file type and claims no liveness, grant or qualification", async () => {
    const { live, stale, close } = await sockets();
    try {
      const detail = runner(live).detail;
      expect(runner(stale).detail).toBe(detail);
      expect(detail).toContain("no grant was read and no producer was identified");
      for (const old of [
        "runner socket exists",
        "each run still validates its standing grant",
        "is not a live runner socket",
      ])
        expect(detail).not.toContain(old);
      expect(detail).not.toContain("refuse");
    } finally {
      close();
    }
  });

  test("a missing path and a regular file fail naming the socket-type file test, not liveness", () => {
    for (const socket of [missing, regular]) {
      const detail = runner(socket).detail;
      expect(detail).toBe(`${socket} is not a socket-type file`);
      expect(detail).not.toContain("liveness");
    }
  });

  test("the guide and every state's detail carry the shared phrases and none of the forbidden ones", async () => {
    const { live, stale, close } = await sockets();
    try {
      const guide = guidePassage(readFileSync(GUIDE, "utf8"));
      const details: Record<State, string[]> = {
        "no-socket": [runner().detail],
        socket: [runner(live).detail, runner(stale).detail],
        "not-socket": [runner(missing).detail, runner(regular).detail],
      };
      expect(tieViolations(guide, details)).toEqual([]);
      // Guide-only drift is detected: one phrase removed, or one forbidden phrase added, from a copy of the guide.
      for (const [id, phrase, , inGuide] of PHRASES)
        if (inGuide) expect(tieViolations(guide.replaceAll(phrase, ""), details), id).not.toEqual([]);
      expect(tieViolations(`${guide} ${FORBIDDEN[0]}`, details)).not.toEqual([]);
    } finally {
      close();
    }
  });
});
