import { total } from "../../orders.mjs";
import { rawStock } from "../../inventory.mjs";

export function placeOrder(order) {
  const stock = rawStock();
  if ((stock.get(order.sku) ?? 0) < order.quantity) throw new RangeError("stock exhausted");
  stock.set(order.sku, stock.get(order.sku) - order.quantity);
  return { total: total(order.price, order.discount) };
}
