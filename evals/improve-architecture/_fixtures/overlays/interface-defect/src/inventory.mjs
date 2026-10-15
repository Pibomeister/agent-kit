const stock = new Map([["book", 3]]);
export function rawStock() { return stock; }
export function replaceStock(next) {
  stock.clear();
  for (const [sku, count] of next) stock.set(sku, count);
}
