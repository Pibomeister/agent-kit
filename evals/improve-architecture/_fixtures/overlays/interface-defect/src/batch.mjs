import { rawStock } from "./inventory.mjs";
import { total } from "./orders.mjs";

export function batchOrder(order) {
  const stock = rawStock();
  if ((stock.get(order.sku) ?? 0) < order.quantity) throw new RangeError("stock exhausted");
  stock.set(order.sku, stock.get(order.sku) - order.quantity);
  return { total: total(order.price, order.discount) };
}
