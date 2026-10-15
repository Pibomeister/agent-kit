export function total(price, discount) {
  if (price < 0 || discount < 0 || discount > price) {
    throw new RangeError("invalid price or discount");
  }
  return price - discount;
}
