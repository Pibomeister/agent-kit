import { total } from "../../orders.mjs";

export function placeOrder(order) {
  return { total: total(order.price, order.discount) };
}
