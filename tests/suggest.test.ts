import { describe, expect, test } from "bun:test";

import * as gate from "../src/lifecycle/gate.ts";
import { closest, unknownSelector } from "../src/util/suggest.ts";

const PROFILES = ["core", "learning", "maintainer", "product", "autonomy", "all"];
const PATTERNS = Array.from({ length: 20 }, (_, i) => `rp-${String(i + 1).padStart(3, "0")}`);

describe("closest", () => {
  test("a typo, a swap, a prefix and a case slip each find their target", () => {
    expect(closest("cor", PROFILES)).toEqual(["core"]);
    expect(closest("lerning", PROFILES)).toEqual(["learning"]);
    expect(closest("learnign", PROFILES)).toEqual(["learning"]);
    expect(closest("maint", PROFILES)).toEqual(["maintainer"]);
    expect(closest("CORE", PROFILES)).toEqual(["core"]);
  });

  test("nothing close is nothing, and an empty or one-letter input matches nothing by containment", () => {
    expect(closest("bogus", PROFILES)).toEqual([]);
    expect(closest("", PROFILES)).toEqual([]);
    expect(closest("x", ["xylophone", "box"])).toEqual([]);
  });

  test("at most three, nearest first, ties in code-point order", () => {
    expect(closest("review", ["review-full", "review-readiness", "reviews", "preview", "x"])).toEqual([
      "preview",
      "reviews",
      "review-full",
    ]);
  });
});

describe("unknownSelector", () => {
  test("names the selector and what was probably meant", () => {
    expect(unknownSelector("profile", "lerning", PROFILES)).toBe("unknown profile 'lerning'; did you mean learning?");
    expect(unknownSelector("verb", "stauts", ["status", "start", "ledger"])).toBe(
      "unknown verb 'stauts'; did you mean status or start?",
    );
  });

  test("with nothing close, a small set is listed whole in its own order", () => {
    expect(unknownSelector("profile", "bogus", PROFILES)).toBe(
      "unknown profile 'bogus'; valid: core, learning, maintainer, product, autonomy, all",
    );
  });

  test("with nothing close, a large set gives its three nearest and its size", () => {
    expect(unknownSelector("pattern", "zz", PATTERNS)).toMatch(/^unknown pattern 'zz'; nearest of 20: \S+, \S+, \S+$/);
  });

  test("an empty set says so rather than listing nothing", () => {
    expect(unknownSelector("candidate", "sk-001", [])).toBe(
      "unknown candidate 'sk-001'; there are none to choose from",
    );
  });

  test("the lifecycle gate's node-only copy gives the same answers", () => {
    const cases: Array<[string, readonly string[]]> = [
      ["cor", PROFILES],
      ["bogus", PROFILES],
      ["", PROFILES],
      ["zz", PATTERNS],
      ["rp-1", PATTERNS],
      ["chek", ["open", "record", "check", "bypass grant", "bypass check"]],
      ["anything", []],
    ];
    for (const [input, candidates] of cases) {
      expect(gate.closest(input, candidates)).toEqual(closest(input, candidates));
      expect(gate.unknownSelector("x", input, candidates)).toBe(unknownSelector("x", input, candidates));
    }
  });
});
