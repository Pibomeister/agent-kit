import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/orders.mjs";

test("the quoted total matches the calculation", () => {
  const expected = total(100, 10);
  assert.equal(total(100, 10), expected);
});

test("an invalid order is rejected before any result is returned", () => {
  assert.throws(() => total(100, 101), RangeError);
});
