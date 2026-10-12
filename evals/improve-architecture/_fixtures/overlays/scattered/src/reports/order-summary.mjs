import { total } from "../orders.mjs";
import { readPrice } from "../shared/price.mjs";
import { readDiscount } from "../shared/discount.mjs";
export function orderSummary(order) { return { total: total(readPrice(order), readDiscount(order)) }; }
