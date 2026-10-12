import { readPrice } from "../shared/price.mjs";
import { readDiscount } from "../shared/discount.mjs";
import { total } from "../orders.mjs";
export function quote(order) { return total(readPrice(order), readDiscount(order)); }
