import { quote } from "../../services/quote.mjs";
export function placeOrder(order) { return { total: quote(order) }; }
