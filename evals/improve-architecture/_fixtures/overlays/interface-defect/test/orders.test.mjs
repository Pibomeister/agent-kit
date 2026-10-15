import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/orders.mjs";
import { rawStock, replaceStock } from "../src/inventory.mjs";
import { dispatch } from "../src/dispatch.mjs";
import { batchOrder } from "../src/batch.mjs";

test("both callers must perform stock and pricing orchestration", async () => {
  replaceStock([["book", 3]]);
  const order = { price: 100, discount: 10, sku: "book", quantity: 1 };
  assert.deepEqual(await dispatch("orders", order), { total: 90 });
  assert.deepEqual(batchOrder(order), { total: 90 });
  assert.equal(rawStock().get("book"), 1);
});

test("the price invariant survives a caller refactor", () => {
  assert.throws(() => total(100, 101), RangeError);
});
