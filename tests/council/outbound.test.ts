import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BUILT_IN_DENY, checkOutbound, deniedBy, DEFAULT_MAX_BYTES } from "../../src/council/outbound.ts";
import { seatEnv } from "../../src/council/cli.ts";
import type { CouncilSeat } from "../../src/council/config.ts";
import { councilOutcome, vetoRefusal, type AnsweredVeto } from "../../src/council/rule.ts";
import { launchSeat } from "../../src/council/seat.ts";
import { processScratch } from "../helpers/process-tmp.ts";

// Built from parts so the sample is not itself a credential-shaped literal in the tree.
const TOKEN = ["gh", "p_", "a1".repeat(18)].join("");

const ok = (choice: string) => ({
  exitCode: 0,
  stdout: Buffer.from(JSON.stringify({ choice, rationale: "r" })),
  stderr: Buffer.from(""),
});

const veto = (over: Partial<AnsweredVeto> = {}): AnsweredVeto => ({
  status: "answered",
  seat: "veto",
  actor: "v",
  lineage: ["v"],
  dispatch: "d",
  choice: "yes",
  rationale: "r",
  ...over,
});

describe("council outbound gate", () => {
  test("caller-supplied context passes when it is clean, small and not deny-listed", () => {
    expect(checkOutbound([{ label: "notes.md", path: "docs/notes.md", text: "plain context" }])).toEqual([]);
  });

  test("a deny-listed path segment refuses, whatever its position in the path", () => {
    for (const path of [".env", "app/.env.local", "keys/server.pem", "home/.ssh/config", "repo/.git/config"])
      expect(deniedBy(path)).not.toBeNull();
    expect(deniedBy("src/environment.ts")).toBeNull();
    expect(deniedBy("docs/private-notes.md", ["private-*"])).toBe("private-*");
    expect(BUILT_IN_DENY).toContain(".npmrc");
    expect(checkOutbound([{ label: "x", path: "id_rsa.pub", text: "" }])).toMatchObject([{ kind: "deny-listed" }]);
  });

  test("a link with an innocent name to a denied file is refused as the file", () => {
    const dir = processScratch("ak-outbound-");
    writeFileSync(join(dir, ".env"), "NAME=value");
    symlinkSync(join(dir, ".env"), join(dir, "notes.md"));
    expect(deniedBy(join(dir, "notes.md"))).toBe(".env");
  });

  test("a detected credential refuses the payload and the refusal never carries the value", () => {
    const refusals = checkOutbound([{ label: "ctx", text: `token: ${TOKEN}` }]);
    expect(refusals).toMatchObject([{ kind: "secret", label: "ctx" }]);
    expect(JSON.stringify(refusals)).not.toContain(TOKEN);
  });

  test("a home path alone is not a credential", () => {
    expect(checkOutbound([{ label: "ctx", text: "see /home/someone/project/readme" }])).toEqual([]);
  });

  test("the size cap counts the whole payload and is configurable", () => {
    expect(checkOutbound([{ label: "a", text: "x".repeat(DEFAULT_MAX_BYTES + 1) }])).toMatchObject([
      { kind: "too-large" },
    ]);
    expect(
      checkOutbound(
        [
          { label: "a", text: "x".repeat(6) },
          { label: "b", text: "x".repeat(6) },
        ],
        { max_bytes: 10 },
      ),
    ).toMatchObject([{ kind: "too-large" }]);
    expect(
      checkOutbound([{ label: "a", text: "x".repeat(8) }], { max_bytes: 10 }, `{"a":"${"x".repeat(8)}"}`),
    ).toMatchObject([{ kind: "too-large" }]);
  });
});

describe("council seats", () => {
  const seat: CouncilSeat = {
    seat: "veto",
    chain: [
      { actor: "v1", lineage: ["v1"], command: ["first"] },
      { actor: "v2", lineage: ["v2"], command: ["second"] },
    ],
  };

  test("a valid answer is never replaced by a substitute, whatever it chose", async () => {
    const launched: string[] = [];
    const result = await launchSeat(seat, "{}", ["yes", "no"], (launcher) => {
      launched.push(launcher.actor);
      return Promise.resolve(ok(launcher.actor === "v1" ? "no" : "yes"));
    });
    expect(launched).toEqual(["v1"]);
    expect(result).toMatchObject({ ok: true, answer: { choice: "no" } });
  });

  test("a choice outside the options moves to the substitute", async () => {
    const result = await launchSeat(seat, "{}", ["yes", "no"], (launcher) =>
      Promise.resolve(ok(launcher.actor === "v1" ? "maybe" : "yes")),
    );
    expect(result).toMatchObject({ ok: true, launcher: { actor: "v2" }, attempts: [{ actor: "v1" }, { actor: "v2" }] });
    expect(JSON.stringify(result)).toContain("not an option");
  });

  test("a launcher sees only the base environment and the names its roster entry lists", () => {
    process.env["AK_COUNCIL_TEST_LISTED"] = "listed";
    process.env["AK_COUNCIL_TEST_UNLISTED"] = "unlisted";
    process.env["AK_RUNNER_TOKEN"] = "never";
    try {
      const env = seatEnv(["AK_COUNCIL_TEST_LISTED", "AK_RUNNER_TOKEN"]);
      expect(env["AK_COUNCIL_TEST_LISTED"]).toBe("listed");
      expect(env["AK_COUNCIL_TEST_UNLISTED"]).toBeUndefined();
      expect(env["AK_RUNNER_TOKEN"]).toBeUndefined();
      expect(env["PATH"]).toBe(process.env["PATH"]);
    } finally {
      delete process.env["AK_COUNCIL_TEST_LISTED"];
      delete process.env["AK_COUNCIL_TEST_UNLISTED"];
      delete process.env["AK_RUNNER_TOKEN"];
    }
  });
});

describe("council rule", () => {
  const pair = [
    { actor: "s1", lineage: ["s1"] },
    { actor: "s2", lineage: ["s2"] },
  ];

  test("the veto lets an approval stand only when it is recorded, independent and approving", () => {
    expect(vetoRefusal("yes", veto(), pair, ["impl"])).toBeNull();
    expect(vetoRefusal("yes", undefined, pair, [])).toContain("none was recorded");
    expect(vetoRefusal("yes", { status: "unavailable", seat: "veto", failures: ["x"] }, pair, [])).toContain(
      "unavailable",
    );
    expect(vetoRefusal("yes", veto({ lineage: ["v", "s1"] }), pair, [])).toContain("not independent");
    expect(vetoRefusal("yes", veto({ lineage: ["v", "impl"] }), pair, ["impl"])).toContain("not independent");
    expect(vetoRefusal("yes", veto({ lineage: ["other"] }), pair, [])).toContain("not independent");
    expect(vetoRefusal("yes", veto({ choice: "no" }), pair, [])).toContain("did not approve");
  });

  test("only three approvals approve", () => {
    expect(councilOutcome("yes", ["yes", "yes"], "yes")).toEqual({ outcome: "approve", choice: "yes", causes: [] });
  });

  test("the veto only refuses: a non-approving, missing or unasked veto escalates", () => {
    expect(councilOutcome("yes", ["yes", "yes"], "no").outcome).toBe("escalate");
    expect(councilOutcome("yes", ["yes", "yes"], null).outcome).toBe("escalate");
    expect(councilOutcome("yes", ["yes", "yes"], undefined).outcome).toBe("escalate");
  });

  test("a split or a missing primary seat escalates, and the veto never breaks a tie", () => {
    expect(councilOutcome("yes", ["yes", "no"], "yes").outcome).toBe("escalate");
    expect(councilOutcome("yes", ["yes", null], "yes").outcome).toBe("escalate");
    expect(councilOutcome("yes", ["yes"], "yes").outcome).toBe("escalate");
  });

  test("a pair agreeing not to approve declines without the veto", () => {
    expect(councilOutcome("yes", ["no", "no"], undefined)).toEqual({ outcome: "decline", choice: "no", causes: [] });
  });
});
