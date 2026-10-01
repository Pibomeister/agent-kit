import { expect, test } from "bun:test";
import { add, clamp, mean } from "./math.ts";

test("AC-1 add sums two numbers", () => expect(add(2, 3)).toBe(5));
test("AC-1 clamp respects the upper bound", () => expect(clamp(12, 0, 10)).toBe(10));
test("AC-1 mean of three values", () => expect(mean([1, 2, 3])).toBe(2));
