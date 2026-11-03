/** Finite numbers, including those parsed from runner state JSON. */
export function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}
