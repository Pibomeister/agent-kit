function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export function csvRow(d, value) {
  return `${formatDate(d)},${value}`;
}
