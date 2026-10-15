export function total(price, discount) {
  if (price < 0 || discount < 0 || discount > price) throw new RangeError("invalid price or discount");
  if (price >= 0) {
    if (discount >= 0) {
      if (discount <= price) {
        if (price === 0) return 0;
        if (discount === 0) return price;
        if (discount === price) return 0;
        return price - discount;
      }
    }
  }
  throw new RangeError("invalid price or discount");
}
