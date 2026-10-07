/**
 * The eval statistics against values worked by hand or by a second implementation: Wilson bounds,
 * pass^k, Cohen's κ on a textbook table, and a seeded bootstrap that repeats exactly.
 */
import { describe, expect, test } from "bun:test";
import { cohenKappa, kappaTable, pairedBootstrap, passHatK, perCase, rng, type Run, wilson } from "./evals/stats.ts";

describe("wilson", () => {
  test("matches the closed form at 8/10, 50/100 and the edges", () => {
    const w = wilson(8, 10);
    expect(w.estimate).toBe(0.8);
    expect(w.lo).toBeCloseTo(0.490157, 5);
    expect(w.hi).toBeCloseTo(0.943319, 5);
    expect(wilson(50, 100).lo).toBeCloseTo(0.40383, 5);
    expect(wilson(50, 100).hi).toBeCloseTo(0.59617, 5);
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(0, 10).hi).toBeCloseTo(0.27754, 5);
    expect(wilson(10, 10).hi).toBe(1);
  });

  test("wilson(k, n) needs no z and carries lo and hi", () => {
    const { lo, hi } = wilson(3, 4);
    expect(lo).toBeLessThan(0.75);
    expect(hi).toBeGreaterThan(0.75);
  });

  test("an empty sample is the whole unit interval", () => {
    expect(wilson(0, 0)).toEqual({ estimate: 0, lo: 0, hi: 1 });
  });
});

const runs = (id: string, ...passes: boolean[]): Run[] => passes.map((pass) => ({ case: id, pass }));

describe("per-case rates and pass^k", () => {
  test("groups runs by case in first-seen order", () => {
    const rows = perCase([...runs("a", true, false), ...runs("b", true), ...runs("a", true)]);
    expect(rows.map((r) => [r.case, r.passes, r.n])).toEqual([
      ["a", 2, 3],
      ["b", 1, 1],
    ]);
  });

  test("pass^k is all-k-pass when n = k, and C(c,k)/C(n,k) otherwise", () => {
    expect(passHatK([...runs("a", true, true, true), ...runs("b", true, false, true)], 3)).toBe(0.5);
    // 2 passes of 3 runs at k = 2: C(2,2)/C(3,2) = 1/3.
    expect(passHatK(runs("a", true, false, true), 2)).toBeCloseTo(1 / 3, 10);
    expect(passHatK(runs("a", true, false, true), 1)).toBeCloseTo(2 / 3, 10);
  });

  test("cases with fewer than k runs are left out", () => {
    expect(passHatK([...runs("a", true, true), ...runs("b", false)], 2)).toBe(1);
    expect(passHatK(runs("a", true), 2)).toBe(0);
  });
});

describe("cohenKappa", () => {
  test("textbook 2x2: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no gives 0.4", () => {
    const a = [...Array(20).fill("Y"), ...Array(5).fill("Y"), ...Array(10).fill("N"), ...Array(15).fill("N")];
    const b = [...Array(20).fill("Y"), ...Array(5).fill("N"), ...Array(10).fill("Y"), ...Array(15).fill("N")];
    expect(cohenKappa(a, b)).toBeCloseTo(0.4, 10);
  });

  test("perfect agreement is 1, systematic disagreement is negative, and total chance agreement is undefined", () => {
    expect(cohenKappa(["P", "F", "P"], ["P", "F", "P"])).toBe(1);
    expect(cohenKappa(["P", "F"], ["F", "P"])).toBe(-1);
    expect(cohenKappa(["P", "P"], ["P", "P"])).toBeNull();
    expect(cohenKappa([], [])).toBeNull();
    expect(() => cohenKappa(["P"], [])).toThrow();
  });

  test("kappaTable pairs every rater over the items both rated", () => {
    const table = kappaTable({
      r1: { x: "P", y: "F", z: "P" },
      r2: { x: "P", y: "F", z: "P", w: "F" },
      r3: { x: "F", y: "P" },
    });
    expect(table.map((row) => [row.a, row.b, row.n])).toEqual([
      ["r1", "r2", 3],
      ["r1", "r3", 2],
      ["r2", "r3", 2],
    ]);
    expect(table[0]!.kappa).toBe(1);
    expect(table[1]!.kappa).toBe(-1);
  });
});

describe("pairedBootstrap", () => {
  const cases = [
    { case: "a", a: [1, 1, 1], b: [0, 0, 1] },
    { case: "b", a: [1, 0], b: [1, 0] },
    { case: "c", a: [1], b: [0] },
    { case: "d", a: [0, 1], b: [0, 0] },
  ];

  test("the estimate is the mean per-case difference, with the case as the cluster", () => {
    const r = pairedBootstrap(cases, { iterations: 2000, seed: 7 });
    expect(r.estimate).toBeCloseTo((2 / 3 + 0 + 1 + 0.5) / 4, 10);
    expect(r.clusters).toBe(4);
    expect(r.lo).toBeLessThanOrEqual(r.estimate);
    expect(r.hi).toBeGreaterThanOrEqual(r.estimate);
    expect(r.lo).toBeGreaterThanOrEqual(0);
    expect(r.hi).toBeLessThanOrEqual(1);
  });

  test("the same seed gives the same interval", () => {
    expect(pairedBootstrap(cases, { seed: 3, iterations: 500 })).toEqual(
      pairedBootstrap(cases, { seed: 3, iterations: 500 }),
    );
    // And the seed is used: two seeds at a small iteration count resample differently.
    const interval = (seed: number) => {
      const r = pairedBootstrap(cases, { seed, iterations: 20 });
      return [r.lo, r.hi];
    };
    expect(interval(3)).not.toEqual(interval(6));
  });

  test("identical arms give a zero-width interval at zero", () => {
    const same = cases.map((c) => ({ ...c, b: c.a }));
    const r = pairedBootstrap(same, { iterations: 200 });
    expect([r.estimate, r.lo, r.hi]).toEqual([0, 0, 0]);
  });

  test("cases missing an arm are not clusters", () => {
    expect(pairedBootstrap([{ case: "a", a: [1], b: [] }]).clusters).toBe(0);
  });
});

test("rng is deterministic per seed and stays in [0, 1)", () => {
  const a = rng(42);
  const b = rng(42);
  const xs = Array.from({ length: 100 }, () => a());
  expect(xs).toEqual(Array.from({ length: 100 }, () => b()));
  expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  // mulberry32's published sequence for seed 42, and a different seed gives a different one.
  expect(xs.slice(0, 3)).toEqual([0.6011037519201636, 0.44829055899754167, 0.8524657934904099]);
  const c = rng(43);
  expect(Array.from({ length: 3 }, () => c())).not.toEqual(xs.slice(0, 3));
});
