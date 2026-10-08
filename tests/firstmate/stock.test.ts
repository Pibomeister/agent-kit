import { describe, expect, test } from "bun:test";

import { runFirstmate } from "../../src/firstmate/cli.ts";
import { preflightStock, stockBrief } from "../../src/firstmate/stock.ts";
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
