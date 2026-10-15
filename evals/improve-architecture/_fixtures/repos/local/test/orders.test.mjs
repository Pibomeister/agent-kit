import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/orders.mjs";
import { dispatch } from "../src/dispatch.mjs";

test("the stated discount changes the caller-visible total", () => {
  assert.equal(total(100, 10), 90);
});

test("an invalid order is rejected before any result is returned", () => {
  assert.throws(() => total(100, 101), RangeError);
});

test("the dispatcher keeps its route entry contract", async () => {
  assert.deepEqual(await dispatch("orders", { price: 100, discount: 10 }), { total: 90 });
});
