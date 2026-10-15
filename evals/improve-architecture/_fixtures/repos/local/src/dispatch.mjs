export async function dispatch(route, input) {
  const entry = await import(`./routes/${route}/index.mjs`);
  return entry.placeOrder(input);
}
